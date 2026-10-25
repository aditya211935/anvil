import { describe, expect, it } from "vitest";
import { compile } from "../../compile.js";
import type { ScaffoldEndpoint } from "./model.js";
import { emitOpenApiDraft, SCAFFOLD_EXTENSION } from "./openapi-draft.js";

const getOrder: ScaffoldEndpoint = {
  framework: "jaxrs",
  method: "get",
  path: "/orders/{orderId}",
  operationId: "OrderResource.getOrder",
  handler: { type: "OrderResource", member: "getOrder" },
  parameters: [
    {
      name: "orderId",
      in: "path",
      required: true,
      schema: { type: "string", sourceType: "java.lang.String" },
      evidence: [{ path: "src/OrderResource.java", line: 12, construct: "@PathParam" }],
    },
    {
      name: "expand",
      in: "query",
      required: false,
      schema: { type: "boolean", sourceType: "boolean" },
      evidence: [{ path: "src/OrderResource.java", line: 13, construct: "@QueryParam" }],
    },
  ],
  response: {
    contentTypes: ["application/json"],
    schema: { type: "object", sourceType: "com.acme.Order" },
    required: false,
    evidence: [{ path: "src/OrderResource.java", line: 11, construct: "@Produces" }],
  },
  evidence: [{ path: "src/OrderResource.java", line: 10, construct: "@GET" }],
};

const cancelOrder: ScaffoldEndpoint = {
  framework: "jaxrs",
  method: "post",
  path: "/orders/{orderId}/cancel",
  operationId: "OrderResource.cancelOrder",
  handler: { type: "OrderResource", member: "cancelOrder" },
  parameters: [],
  requestBody: {
    contentTypes: [],
    schema: { type: "object", sourceType: "com.acme.CancelRequest" },
    required: true,
    evidence: [{ path: "src/OrderResource.java", line: 20 }],
  },
  evidence: [{ path: "src/OrderResource.java", line: 19, construct: "@POST" }],
};

const servletOnly: ScaffoldEndpoint = {
  framework: "servlet",
  path: "/legacy/*",
  operationId: "LegacyServlet",
  handler: { type: "com.acme.LegacyServlet", member: "service" },
  parameters: [],
  evidence: [{ path: "WEB-INF/web.xml", line: 7, construct: "servlet-mapping" }],
};

describe("emitOpenApiDraft", () => {
  it("is deterministic regardless of endpoint order and records evidence on every operation", () => {
    const a = emitOpenApiDraft({
      title: "orders",
      scaffold: {
        endpoints: [getOrder, cancelOrder, servletOnly],
        diagnostics: [],
        inputMembers: 2,
      },
    });
    const b = emitOpenApiDraft({
      title: "orders",
      scaffold: {
        endpoints: [servletOnly, cancelOrder, getOrder],
        diagnostics: [],
        inputMembers: 2,
      },
    });
    expect(JSON.stringify(a.document)).toBe(JSON.stringify(b.document));
    expect(a.contentHash).toBe(b.contentHash);
    const paths = a.document.paths as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths)).toEqual(["/orders/{orderId}", "/orders/{orderId}/cancel"]);
    expect(paths["/orders/{orderId}"]?.get?.["x-anvil-evidence"]).toEqual([
      { path: "src/OrderResource.java", line: 10, construct: "@GET" },
    ]);
    // A path with no declared method is never turned into an operation.
    expect(a.unmapped).toHaveLength(1);
    const ext = a.document[SCAFFOLD_EXTENSION] as { unmapped: unknown[]; operations: number };
    expect(ext.unmapped).toHaveLength(1);
    expect(ext.operations).toBe(2);
  });

  it("fills missing path parameters as required strings and keeps undeclared shapes open", () => {
    const draft = emitOpenApiDraft({
      title: "orders",
      scaffold: { endpoints: [cancelOrder], diagnostics: [], inputMembers: 1 },
    });
    const paths = draft.document.paths as Record<string, Record<string, Record<string, unknown>>>;
    const op = paths["/orders/{orderId}/cancel"]?.post;
    expect(op?.parameters).toEqual([
      expect.objectContaining({ name: "orderId", in: "path", required: true }),
    ]);
    const body = op?.requestBody as {
      content: Record<string, { schema: Record<string, unknown> }>;
    };
    expect(body.content["application/json"]?.schema).toEqual({
      type: "object",
      additionalProperties: true,
      "x-anvil-source-type": "com.acme.CancelRequest",
    });
  });

  it("reports duplicate operation ids and routes as errors instead of guessing", () => {
    const dup = { ...cancelOrder, path: "/orders/{orderId}/void" };
    const draft = emitOpenApiDraft({
      title: "orders",
      scaffold: { endpoints: [cancelOrder, dup], diagnostics: [], inputMembers: 1 },
    });
    expect(draft.diagnostics.map((d) => d.code)).toEqual([
      "legacy/scaffold/jaxrs/duplicate_operation_id",
    ]);
  });

  it("compiles through the ordinary pipeline with reads read and mutations gated", async () => {
    const draft = emitOpenApiDraft({
      title: "orders",
      scaffold: { endpoints: [getOrder, cancelOrder], diagnostics: [], inputMembers: 2 },
    });
    const air = await compile({ spec: JSON.stringify(draft.document) });
    const byId = new Map(air.operations.map((op) => [op.sourceRef.operationId, op]));
    expect(byId.get("OrderResource.getOrder")?.effect.kind).toBe("read");
    const cancel = byId.get("OrderResource.cancelOrder");
    expect(cancel?.effect.kind).not.toBe("read");
    expect(cancel?.state).not.toBe("approved");
  });
});
