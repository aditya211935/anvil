import {
  agentPropKey,
  type Operation,
  Operation as OperationSchema,
  operationBusinessInputCliFlag,
  operationInputSchema,
  type Param,
} from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";
import { disambiguateInputNames, resolveInputNameCollisions } from "./input-names.js";
import { validate } from "./validate.js";

type RawParam = { name: string; in: Param["in"]; agentName?: string };

function readOp(params: RawParam[], body?: Operation["input"]["body"]): Operation {
  return OperationSchema.parse({
    id: "svc.things.list",
    canonicalName: "list_things",
    displayName: "List things",
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "none" },
    input: {
      params: params.map((p) => ({ ...p, required: p.in === "path", schema: { type: "string" } })),
      ...(body ? { body } : {}),
    },
    idempotency: { mode: "natural" },
    retries: { mode: "safe" },
    confirmation: { required: false, risk: "none" },
    auth: { type: "api_key", scopes: [] },
    cli: { command: "svc things list" },
    mcp: { toolName: "svc_list_things" },
    skill: { intentExamples: [] },
    state: "generated",
  });
}

const keysOf = (op: Operation) => op.input.params.map((p) => agentPropKey(p));
const wiresOf = (op: Operation) => op.input.params.map((p) => `${p.in}:${p.name}`);

describe("disambiguateInputNames", () => {
  it("leaves an operation without collisions byte-identical", () => {
    const op = readOp([
      { name: "EndTime", in: "query" },
      { name: "StartTime", in: "query" },
      { name: "role[]", in: "query" },
    ]);
    const before = structuredClone(op);
    expect(disambiguateInputNames(op)).toEqual([]);
    expect(op).toEqual(before);
    // A lone bracketed or operator-suffixed name is NOT renamed: `role[]`
    // simply projects to `role`, as it always did.
    expect(keysOf(op)).toEqual(["end_time", "start_time", "role"]);
  });

  it("rule 1: comparison operators snake_case erases become _lt/_gt/_lte/_gte/_ne", () => {
    const op = readOp([
      { name: "EndTime", in: "query" },
      { name: "EndTime<", in: "query" },
      { name: "EndTime>", in: "query" },
      { name: "Size", in: "query" },
      { name: "Size<=", in: "query" },
      { name: "Size>=", in: "query" },
      { name: "Size!=", in: "query" },
      { name: "Kind", in: "query" },
      { name: "Kind<>", in: "query" },
    ]);
    const renames = disambiguateInputNames(op);
    expect(keysOf(op)).toEqual([
      "end_time",
      "end_time_lt",
      "end_time_gt",
      "size",
      "size_lte",
      "size_gte",
      "size_ne",
      "kind",
      "kind_ne",
    ]);
    // The bare spelling keeps its default projection; only the suffixed ones moved.
    expect(op.input.params[0]?.agentName).toBeUndefined();
    expect(renames.map((r) => r.rule)).toEqual(Array(6).fill("comparison_operator"));
    // Wire names are untouched.
    expect(wiresOf(op)).toEqual([
      "query:EndTime",
      "query:EndTime<",
      "query:EndTime>",
      "query:Size",
      "query:Size<=",
      "query:Size>=",
      "query:Size!=",
      "query:Kind",
      "query:Kind<>",
    ]);
  });

  it("rule 1 applies without a bare sibling too", () => {
    const op = readOp([
      { name: "DateSent<", in: "query" },
      { name: "DateSent>", in: "query" },
    ]);
    disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["date_sent_lt", "date_sent_gt"]);
  });

  it("rule 2: the array-bracket spelling takes _list and the plain one keeps the bare key", () => {
    const op = readOp([
      { name: "role", in: "query" },
      { name: "role[]", in: "query" },
    ]);
    const renames = disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["role", "role_list"]);
    expect(renames).toEqual([
      { wire: "query:role[]", agentKey: "role_list", rule: "array_bracket" },
    ]);
  });

  it("rule 3: the path parameter keeps the bare key and other locations take a location suffix", () => {
    const op = readOp([
      { name: "userId", in: "query" },
      { name: "user-id", in: "path" },
      { name: "User-Id", in: "header" },
    ]);
    const renames = disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["user_id_query", "user_id", "user_id_header"]);
    expect(renames.map((r) => r.rule)).toEqual(["location", "location"]);
  });

  it("rule 3 ranks query over header when no path parameter is involved", () => {
    const op = readOp([
      { name: "X-Trace", in: "header" },
      { name: "xTrace", in: "query" },
    ]);
    disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["x_trace_header", "x_trace"]);
  });

  it("rule 3 moves a parameter off the reserved whole-body `body` envelope", () => {
    const op = readOp([{ name: "body", in: "query" }], {
      contentType: "application/json",
      required: true,
      schema: { type: "object", properties: { nested: { type: "object" } } },
      projection: "whole",
      fields: [],
    });
    disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["body_query"]);
    expect(Object.keys(operationInputSchema(op).properties ?? {})).toEqual(["body_query", "body"]);
  });

  it("rule 4: case-only variants in one location take ordinals in wire order", () => {
    const op = readOp([
      { name: "UserName", in: "path" },
      { name: "userName", in: "path" },
      { name: "user_name", in: "path" },
    ]);
    const renames = disambiguateInputNames(op);
    expect(keysOf(op)).toEqual(["user_name", "user_name_2", "user_name_3"]);
    expect(renames.map((r) => r.rule)).toEqual(["ordinal", "ordinal"]);
    // Running the pass again is a no-op: the result is a fixed point.
    expect(disambiguateInputNames(op)).toEqual([]);
    expect(keysOf(op)).toEqual(["user_name", "user_name_2", "user_name_3"]);
  });

  it("never lands a candidate on a key another input already occupies", () => {
    const op = readOp([
      { name: "EndTimeLt", in: "query" },
      { name: "EndTime", in: "query" },
      { name: "EndTime<", in: "query" },
      { name: "user_id", in: "query" },
      { name: "userId", in: "query" },
      { name: "user_id_2", in: "query" },
    ]);
    disambiguateInputNames(op);
    expect(keysOf(op)).toEqual([
      "end_time_lt",
      "end_time",
      "end_time_lt_2",
      "user_id",
      "user_id_3",
      "user_id_2",
    ]);
    expect(new Set(keysOf(op)).size).toBe(6);
  });

  it("treats a chosen agentName as a fixed point and moves the undecided input instead", () => {
    const op = readOp([
      { name: "ts", in: "query", agentName: "timestamp" },
      { name: "timestamp", in: "query" },
    ]);
    disambiguateInputNames(op);
    expect(op.input.params[0]?.agentName).toBe("timestamp");
    expect(keysOf(op)).toEqual(["timestamp", "timestamp_query"]);
  });

  it("does not resolve two chosen names that collide, so the validator still blocks", () => {
    const op = readOp([
      { name: "a", in: "query", agentName: "same" },
      { name: "b", in: "query", agentName: "same" },
    ]);
    expect(disambiguateInputNames(op)).toEqual([]);
    const { operations, diagnostics } = validate([op]);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ code: "duplicate_agent_input_name", level: "error" }),
    );
    expect(operations[0]?.state).toBe("blocked");
  });

  it("records what moved and why on the operation and as an info diagnostic", () => {
    const op = readOp([
      { name: "EndTime", in: "query" },
      { name: "EndTime<", in: "query" },
    ]);
    const diagnostics = resolveInputNameCollisions([op]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: "info",
        code: "agent_input_name_disambiguated",
        operationId: "svc.things.list",
        message: expect.stringContaining(
          "'query:EndTime<' → 'end_time_lt' (comparison-operator suffix)",
        ),
      }),
    ]);
    expect(op.reviewNotes).toEqual([
      expect.stringContaining("'query:EndTime<' → 'end_time_lt' (comparison-operator suffix)"),
    ]);
    expect(resolveInputNameCollisions([readOp([{ name: "EndTime", in: "query" }])])).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * End to end: each vendor shape that used to be blocked compiles unblocked,
 * with the expected agent keys on the one input schema every surface shares.
 * ------------------------------------------------------------------------- */

type PathItem = Record<string, unknown>;

function openapi(paths: Record<string, PathItem>): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Vendor", version: "1" },
    servers: [{ url: "https://vendor.example.test" }],
    paths,
  });
}

const query = (name: string, schema: Record<string, unknown> = { type: "string" }) => ({
  name,
  in: "query",
  schema,
});
const path = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });

async function compileOne(spec: string) {
  const air = await compile({ spec, serviceId: "vendor" });
  const op = air.operations[0];
  if (!op) throw new Error("fixture compiled no operation");
  return { air, op };
}

function expectUnblocked(air: Awaited<ReturnType<typeof compile>>, op: Operation) {
  expect(air.diagnostics.filter((d) => d.code === "duplicate_agent_input_name")).toEqual([]);
  expect(op.state).not.toBe("blocked");
  expect(air.diagnostics).toContainEqual(
    expect.objectContaining({ code: "agent_input_name_disambiguated", operationId: op.id }),
  );
  expect(op.reviewNotes.some((n) => n.includes("re-projected"))).toBe(true);
}

describe("compile: colliding agent input names (vendor shapes)", () => {
  it("Twilio ListCall: EndTime / EndTime< / EndTime> become end_time, end_time_lt, end_time_gt", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/Calls.json": {
          get: {
            operationId: "ListCall",
            parameters: [
              query("StartTime"),
              query("StartTime<"),
              query("StartTime>"),
              query("EndTime"),
              query("EndTime<"),
              query("EndTime>"),
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expectUnblocked(air, op);
    const properties = (op.input.schema?.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(properties)).toEqual([
      "start_time",
      "start_time_lt",
      "start_time_gt",
      "end_time",
      "end_time_lt",
      "end_time_gt",
    ]);
    // The wire coordinate is preserved on the parameter and in the schema.
    expect(op.input.params.map((p) => p.name)).toEqual([
      "StartTime",
      "StartTime<",
      "StartTime>",
      "EndTime",
      "EndTime<",
      "EndTime>",
    ]);
    expect(properties.end_time_lt?.["x-anvil-wire-name"]).toBe("EndTime<");
    // CLI flag, MCP property and the attached schema all derive from one key.
    expect(operationBusinessInputCliFlag(op, "query", "EndTime<")).toBe("--end-time-lt");
    expect(operationBusinessInputCliFlag(op, "query", "EndTime")).toBe("--end-time");
    expect(Object.keys(operationInputSchema(op).properties ?? {})).toEqual(Object.keys(properties));
  });

  it("Zendesk ListUsers: role and role[] become role and role_list", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/users": {
          get: {
            operationId: "ListUsers",
            parameters: [
              query("role"),
              query("role[]", { type: "array", items: { type: "string" } }),
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expectUnblocked(air, op);
    expect(Object.keys(op.input.schema?.properties ?? {})).toEqual(["role", "role_list"]);
    expect(op.input.params.map((p) => p.name)).toEqual(["role", "role[]"]);
    expect(operationBusinessInputCliFlag(op, "query", "role[]")).toBe("--role-list");
  });

  it("Microsoft Graph: path user-id keeps user_id and query userId becomes user_id_query", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/teams/{team-id}/members/{user-id}/access": {
          get: {
            operationId: "teams.doesUserHaveAccess",
            parameters: [path("team-id"), path("user-id"), query("userId")],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expectUnblocked(air, op);
    expect(Object.keys(op.input.schema?.properties ?? {})).toEqual([
      "team_id",
      "user_id",
      "user_id_query",
    ]);
    expect(op.input.params.find((p) => p.in === "query")?.name).toBe("userId");
  });

  it("DocuSign: path langCode keeps lang_code and query langCode becomes lang_code_query", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/accounts/{accountId}/consumer_disclosure/{langCode}": {
          get: {
            operationId: "ConsumerDisclosure_GetConsumerDisclosure",
            parameters: [path("accountId"), path("langCode"), query("langCode")],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expectUnblocked(air, op);
    expect(Object.keys(op.input.schema?.properties ?? {})).toEqual([
      "account_id",
      "lang_code",
      "lang_code_query",
    ]);
  });

  it("OData TripPin: two path keys differing only in case take user_name and user_name_2", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/People('{UserName}')/Friends('{userName}')/Trips": {
          get: {
            operationId: "People.GetFriendsTrips",
            parameters: [path("UserName"), path("userName")],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expectUnblocked(air, op);
    expect(Object.keys(op.input.schema?.properties ?? {})).toEqual(["user_name", "user_name_2"]);
    expect(op.input.params.map((p) => p.name)).toEqual(["UserName", "userName"]);
    // Deterministic across compiles.
    const again = await compileOne(
      openapi({
        "/People('{UserName}')/Friends('{userName}')/Trips": {
          get: {
            operationId: "People.GetFriendsTrips",
            parameters: [path("UserName"), path("userName")],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expect(again.op.input.params.map((p) => p.agentName)).toEqual(
      op.input.params.map((p) => p.agentName),
    );
  });

  it("does not touch the agent names of an operation whose inputs do not collide", async () => {
    const { air, op } = await compileOne(
      openapi({
        "/messages": {
          get: {
            operationId: "ListMessage",
            parameters: [query("DateSent"), query("To"), query("From")],
            responses: { "200": { description: "OK" } },
          },
        },
      }),
    );
    expect(op.input.params.every((p) => p.agentName === undefined)).toBe(true);
    expect(air.diagnostics.filter((d) => d.code === "agent_input_name_disambiguated")).toEqual([]);
  });
});
