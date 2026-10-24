import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { operationSafetyInputKeys } from "@anvil/air";
import { compile } from "@anvil/compiler";
import { describe, expect, it } from "vitest";
import {
  argsFor,
  cliFlagsFor,
  expectedWire,
  wireable,
  wireRefusal,
  withoutConfirmationInput,
} from "./bundle-driver.js";

const fixture = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../examples/fixtures/${name}`, import.meta.url)),
    "utf8",
  );

const COLLISION_SPEC = `openapi: 3.0.0
info: { title: widgets, version: 1.0.0 }
paths:
  /widgets:
    post:
      operationId: createWidget
      tags: [widgets]
      parameters:
        - name: idempotency_key
          in: query
          required: true
          example: business-query-key
          schema: { type: string }
        - name: confirm
          in: query
          required: true
          example: business-confirm
          schema: { type: string }
      responses: { '201': { description: created } }
`;

const COLLISION_MANIFEST = `operations:
  createWidget:
    state: approved
    idempotency:
      strategy: required_request_key
      key_location: header
      header: Idempotency-Key
    confirmation:
      required: true
      risk: high
`;

describe("bundle driver safety-input collisions", () => {
  it("keeps business fields distinct from namespaced safety controls on every driven surface", async () => {
    const air = await compile({
      spec: COLLISION_SPEC,
      manifest: COLLISION_MANIFEST,
      serviceId: "widgets",
    });
    const op = air.operations[0];
    if (!op) throw new Error("fixture: createWidget not compiled");

    const safety = operationSafetyInputKeys(op);
    expect(safety).toEqual({
      idempotencyKey: "anvil_idempotency_key",
      confirm: "anvil_confirm",
    });

    const args = argsFor(op, "collision");
    expect(args.idempotency_key).toBe("business-query-key");
    expect(args.confirm).toBe("business-confirm");
    expect(args[safety.idempotencyKey]).toMatch(/^collision-/);
    expect(args[safety.confirm]).toBe(true);

    expect(cliFlagsFor(op, args)).toEqual([
      "--input-idempotency-key",
      "business-query-key",
      "--input-confirm",
      "business-confirm",
      "--idempotency-key",
      args[safety.idempotencyKey],
    ]);

    const wire = expectedWire(op, args);
    expect(wire.query).toEqual({
      idempotency_key: "business-query-key",
      confirm: "business-confirm",
    });
    expect(wire.headers["idempotency-key"]).toBe(args[safety.idempotencyKey]);

    const unconfirmed = withoutConfirmationInput(op, args);
    expect(unconfirmed.confirm).toBe("business-confirm");
    expect(unconfirmed).not.toHaveProperty(safety.confirm);
  });
});

const STYLE_SPEC = `openapi: 3.0.0
info: { title: catalog, version: 1.0.0 }
paths:
  /items/{ids}:
    get:
      operationId: listItems
      tags: [items]
      parameters:
        - name: ids
          in: path
          required: true
          schema: { type: array, items: { type: string } }
        - name: tag
          in: query
          schema: { type: array, items: { type: string } }
        - name: sort
          in: query
          style: pipeDelimited
          schema: { type: array, items: { type: string } }
        - name: filter
          in: query
          style: deepObject
          schema: { type: object, additionalProperties: { type: string } }
        - name: X-Meta
          in: header
          schema: { type: object, additionalProperties: { type: string } }
      responses:
        "200": { description: ok }
`;

describe("expectedWire serializes parameters by the shared style table", () => {
  it("expects repeated keys, delimited lists, deep objects and simple headers", async () => {
    const air = await compile({ spec: STYLE_SPEC, serviceId: "catalog" });
    const op = air.operations.find((o) => o.sourceRef.operationId === "listItems");
    if (!op) throw new Error("listItems not compiled");
    const wire = expectedWire(op, {
      ids: ["a b", "c"],
      tag: ["x", "y"],
      sort: ["name", "date"],
      filter: { color: "red", size: "m" },
      x_meta: { k: "v" },
    });
    expect(wire.path).toBe("/items/a%20b,c");
    // Exactly the shape the mock records, so a repeat is an array on both sides.
    expect(wire.query).toEqual({
      tag: ["x", "y"],
      sort: "name|date",
      "filter[color]": "red",
      "filter[size]": "m",
    });
    expect(wire.headers["x-meta"]).toBe("k,v");
  });
});

const RENAMED_INPUT_SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Calls", version: "1" },
  servers: [{ url: "https://calls.example.test" }],
  paths: {
    "/Calls.json": {
      get: {
        operationId: "ListCall",
        parameters: [
          { name: "EndTime", in: "query", schema: { type: "string" } },
          { name: "EndTime<", in: "query", schema: { type: "string" } },
          { name: "EndTime>", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
  },
});

describe("bundle driver re-projected input names", () => {
  it("keys the seeded object by the agent key the compiler chose, not the snake-cased wire name", async () => {
    const air = await compile({ spec: RENAMED_INPUT_SPEC, serviceId: "calls" });
    const op = air.operations[0];
    if (!op) throw new Error("fixture: ListCall not compiled");
    expect(op.input.params.map((p) => [p.name, p.agentName])).toEqual([
      ["EndTime", undefined],
      ["EndTime<", "end_time_lt"],
      ["EndTime>", "end_time_gt"],
    ]);
    const args = { end_time: "a", end_time_lt: "b", end_time_gt: "c" };
    expect(cliFlagsFor(op, args)).toEqual([
      "--end-time",
      "a",
      "--end-time-lt",
      "b",
      "--end-time-gt",
      "c",
    ]);
    // The flags round-trip to the exact wire query the MCP surface would send.
    expect(expectedWire(op, args).query).toMatchObject({
      EndTime: "a",
      "EndTime<": "b",
      "EndTime>": "c",
    });
  });
});

describe("expectedWire shapes a form body as the mock captures it", () => {
  it("expects a deepObject field as its bracketed wire pairs, by the body's declared encoding", async () => {
    const air = await compile({
      spec: fixture("ledger-form.yaml"),
      manifest: fixture("ledger-form.anvil.yaml"),
      serviceId: "ledger",
    });
    const capture = air.operations.find(
      (o) => o.sourceRef.operationId === "PostChargesChargeCapture",
    );
    if (!capture) throw new Error("PostChargesChargeCapture not compiled");
    // The compiler carried the media type's `encoding` map into AIR.
    expect(capture.input.body?.encoding).toEqual({
      metadata: { style: "deepObject", explode: true },
      expand: { style: "deepObject", explode: true },
      transfer_data: { style: "deepObject", explode: true },
    });
    const wire = expectedWire(capture, {
      charge: "ch_1",
      body: {
        amount: 1500,
        metadata: { order_id: "o_1", tier: "gold" },
        expand: ["customer", "invoice"],
        transfer_data: { amount: 1200, destination: "acct_1" },
      },
      idempotency_key: "k-1",
    });
    expect(wire.path).toBe("/v1/charges/ch_1/capture");
    expect(wire.headers["idempotency-key"]).toBe("k-1");
    // Exactly the record the generated mock writes for a form body: the wire
    // pairs under their on-wire names, values as the text they travelled as.
    expect(wire.body).toEqual({
      amount: "1500",
      "metadata[order_id]": "o_1",
      "metadata[tier]": "gold",
      "expand[0]": "customer",
      "expand[1]": "invoice",
      "transfer_data[amount]": "1200",
      "transfer_data[destination]": "acct_1",
    });

    // Query parameters declared deepObject: an array by index, a range object
    // by key, and the integer branch of the anyOf as the bare scalar.
    const list = air.operations.find((o) => o.sourceRef.operationId === "GetCharges");
    if (!list) throw new Error("GetCharges not compiled");
    expect(
      expectedWire(list, { created: { gt: 1, lt: 2 }, expand: ["data.customer"], limit: 3 }).query,
    ).toEqual({ "created[gt]": "1", "created[lt]": "2", "expand[0]": "data.customer", limit: "3" });
    expect(expectedWire(list, { created: 7 }).query).toEqual({ created: "7" });
  });
});

describe("wireRefusal names why the hermetic lanes cannot drive an operation", () => {
  it("skips a framing refusal with the protocol and reason, and drives a transcodable unary call", async () => {
    const air = await compile({
      spec: fixture("kv-stream.proto"),
      manifest: fixture("kv-stream.anvil.yaml"),
      serviceId: "kv",
    });
    const range = air.operations.find((o) => o.sourceRef.operationId === "Range");
    const watch = air.operations.find((o) => o.sourceRef.operationId === "Watch");
    if (!range || !watch) throw new Error("fixture no longer has Range and Watch");
    // The unary call carries a `json_transcoded` binding: a coordinates
    // refusal the declared mock facade answers, so the lanes drive it.
    expect(wireable(range)).toBe(true);
    expect(wireRefusal(range)).toBeUndefined();
    // The stream carries no binding: a framing refusal no facade can answer,
    // so the lanes skip it and say so in the runtime's own words.
    expect(wireable(watch)).toBe(false);
    expect(wireRefusal(watch)).toMatch(/^not wire-executable: speaks grpc — /);
    expect(wireRefusal(watch)).toMatch(/length-prefixed protobuf/);
  });
});
