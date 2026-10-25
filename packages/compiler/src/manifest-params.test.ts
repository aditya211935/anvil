import { describe, expect, it } from "vitest";
import { compile } from "./compile.js";

/**
 * Retyping an input by manifest. Slack's contract types a message timestamp
 * as a number; it is an id, and must travel as the string it is.
 */
const SLACK = JSON.stringify({
  swagger: "2.0",
  info: { title: "Slack", version: "1" },
  host: "slack.com",
  basePath: "/api",
  paths: {
    "/chat.delete": {
      post: {
        operationId: "chat_delete",
        consumes: ["application/x-www-form-urlencoded", "application/json"],
        parameters: [
          { name: "ts", in: "formData", type: "number", description: "Timestamp of the message." },
          { name: "channel", in: "formData", type: "string" },
        ],
        responses: { "200": { description: "ok", schema: { type: "object" } } },
      },
    },
    "/conversations.history": {
      get: {
        operationId: "conversations_history",
        parameters: [
          { name: "channel", in: "query", type: "string" },
          { name: "latest", in: "query", type: "number", minimum: 0 },
        ],
        responses: { "200": { description: "ok", schema: { type: "object" } } },
      },
    },
  },
});

const TS = { type: "string", pattern: "^\\d{10}\\.\\d{6}$" };

describe("manifest params", () => {
  it("retypes a body field and a query parameter by wire name, keeping descriptions", async () => {
    const air = await compile({
      spec: SLACK,
      serviceId: "slack",
      manifest: [
        "operations:",
        "  chat_delete:",
        "    params:",
        `      ts: { type: string, pattern: '${TS.pattern}' }`,
        "  conversations_history:",
        "    params:",
        "      latest: { type: string }",
      ].join("\n"),
    });
    const op = (id: string) => air.operations.find((o) => o.sourceRef.operationId === id);
    const del = op("chat_delete");
    const body = del?.input.body;
    const field = body?.fields.find((f) => f.name === "ts");
    const prop = (body?.schema.properties as Record<string, unknown> | undefined)?.ts;
    // A form body may be projected field by field or kept whole; the property
    // is retyped either way, and so is a projected field.
    expect(prop).toEqual({ ...TS, description: "Timestamp of the message." });
    if (field) expect(field.schema).toEqual({ ...TS, description: "Timestamp of the message." });
    expect(del?.reviewNotes).toContain("Input 'ts' retyped by manifest: number → string.");

    const latest = op("conversations_history")?.input.params.find((p) => p.name === "latest");
    // `minimum` constrained the number; it does not survive into the string.
    expect(latest?.schema).toEqual({ type: "string" });
  });

  it("retypes a property below a top-level body field by its dotted name", async () => {
    // Intercom types a contact id as `format: uuid` with min/maxLength 24 — no
    // string satisfies both — and the field sits inside the body's `from` object.
    const spec = `openapi: 3.0.3
info: { title: Intercom, version: 1.0.0 }
paths:
  /conversations:
    post:
      operationId: createConversation
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [from, body]
              properties:
                from:
                  type: object
                  required: [type, id]
                  properties:
                    type: { type: string, enum: [user, lead] }
                    id: { type: string, format: uuid, minLength: 24, maxLength: 24, description: The contact id. }
                body: { type: string }
      responses: { "200": { description: ok } }
`;
    const air = await compile({
      spec,
      serviceId: "intercom",
      manifest: [
        "operations:",
        "  createConversation:",
        "    params:",
        '      "from.id": { type: string, pattern: "^[0-9a-f]{24}$" }',
      ].join("\n"),
    });
    const op = air.operations[0];
    if (!op?.input.body) throw new Error("createConversation did not compile with a body");
    const from = (op.input.body.schema.properties as Record<string, Record<string, unknown>>).from;
    if (!from) throw new Error("body has no `from` property");
    const id = (from.properties as Record<string, Record<string, unknown>>).id;
    expect(id).toEqual({
      type: "string",
      pattern: "^[0-9a-f]{24}$",
      description: "The contact id.",
    });
    // The assembled input schema the MCP server validates against sees the
    // retyped leaf, and the unsatisfiable uuid format is gone from it.
    const served = JSON.stringify(op?.input.schema);
    expect(served).toContain('"pattern":"^[0-9a-f]{24}$"');
    expect(served).not.toContain('"format":"uuid"');
    expect(op?.reviewNotes).toContain("Input 'from.id' retyped by manifest: string → string.");
  });

  it("declines a name nothing carries, with the reason", async () => {
    const air = await compile({
      spec: SLACK,
      serviceId: "slack",
      manifest: [
        "operations:",
        "  chat_delete:",
        "    params:",
        "      tss: { type: string }",
      ].join("\n"),
    });
    const del = air.operations.find((o) => o.sourceRef.operationId === "chat_delete");
    expect(del?.reviewNotes.join(" ")).toContain("params manifest patch for 'tss' left unset");
  });
});
