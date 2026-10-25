import { protocolFacadeApplies, wireExecutability } from "@anvil/air";
import { compile } from "@anvil/compiler";
import {
  finalizeLegacyCapabilityBindingRecord,
  type LegacyCapabilityBinding,
  promoteLegacyCapabilityBindingToConformancePassed,
} from "@anvil/compiler/legacy";
import { describe, expect, it } from "vitest";
import { legacyBridgeInvokePath } from "./facade.js";
import { LegacyLoweringError, lowerLegacyBindings } from "./lower.js";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";
import { buildQueueWireBinding } from "./wire-binding.js";

const REPORT_HASH = `sha256:${"b".repeat(64)}`;

/** The fixture with its reviewed facts changed — a distinct content-addressed record. */
function variant(
  base: LegacyCapabilityBinding,
  change: (
    core: Omit<LegacyCapabilityBinding, "bindingId" | "contentHash">,
  ) => Parameters<typeof finalizeLegacyCapabilityBindingRecord>[0],
): LegacyCapabilityBinding {
  const { bindingId: _bindingId, contentHash: _contentHash, ...core } = base;
  return finalizeLegacyCapabilityBindingRecord(change(core));
}

/** A promoted (`conformance_passed`) read on a different operation name. */
function conformantRead(): LegacyCapabilityBinding {
  return variant(
    promoteLegacyCapabilityBindingToConformancePassed(
      fixtureLegacyCapabilityBinding(),
      REPORT_HASH,
    ),
    (core) => ({
      ...core,
      operation: {
        ...core.operation,
        name: "ledger.read_balance",
        summary: "Read a ledger balance",
        effect: "read",
      },
      semantics: {
        ...core.semantics,
        idempotency: { mode: "natural" },
        retry: { mode: "safe_transient", maxAttempts: 3 },
      },
    }),
  );
}

/** A promoted (`conformance_passed`) mutation whose review said never retry, no idempotency. */
function conformantMutation(): LegacyCapabilityBinding {
  return variant(
    promoteLegacyCapabilityBindingToConformancePassed(
      fixtureLegacyCapabilityBinding(),
      REPORT_HASH,
    ),
    (core) => ({
      ...core,
      operation: { ...core.operation, name: "refunds.reverse_refund" },
      semantics: {
        ...core.semantics,
        idempotency: { mode: "none" },
        retry: { mode: "never", maxAttempts: 1 },
      },
    }),
  );
}

/** A reviewed binding the queue bridge cannot execute (fire-and-forget). */
function fireAndForget(): LegacyCapabilityBinding {
  return variant(fixtureLegacyCapabilityBinding(), (core) => ({
    ...core,
    operation: { ...core.operation, name: "audit.emit_event", effect: "event" },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/AuditEvents",
      direction: "produce",
      payloadEncoding: "json",
      reply: { mode: "none" },
    },
  }));
}

describe("lowerLegacyBindings", () => {
  it("is deterministic and content-addressed regardless of input order", () => {
    const a = fixtureLegacyCapabilityBinding();
    const b = conformantRead();
    const first = lowerLegacyBindings([a, b], { title: "Legacy estate" });
    const second = lowerLegacyBindings([b, a], { title: "Legacy estate" });
    expect(second).toEqual(first);
    expect(first.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.lowered.map((op) => op.operationName)).toEqual([
      "ledger.read_balance",
      "refunds.submit_refund",
    ]);
    // A different reviewed binding is a different lowering.
    const third = lowerLegacyBindings([a], { title: "Legacy estate" });
    expect(third.contentHash).not.toBe(first.contentHash);
  });

  it("projects one OpenAPI operation per binding at the facade's own route", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const { openapi, lowered } = lowerLegacyBindings([binding], { title: "Legacy estate" });
    expect(openapi).toMatchObject({ openapi: "3.0.3", info: { title: "Legacy estate" } });
    const path = legacyBridgeInvokePath("refunds.submit_refund");
    expect(lowered[0]).toMatchObject({
      operationId: "refunds.submit_refund",
      path,
      method: "post",
      executable: true,
      runtimeStatus: "not_implemented",
      manifestState: "blocked",
    });
    const paths = openapi.paths as Record<string, { post: Record<string, unknown> }>;
    const op = paths[path]?.post as Record<string, unknown>;
    expect(op).toMatchObject({
      operationId: "refunds.submit_refund",
      summary: binding.operation.summary,
      description: binding.operation.description,
      requestBody: {
        required: true,
        content: { "application/json": { schema: binding.operation.inputSchema } },
      },
    });
    const responses = op.responses as Record<string, Record<string, unknown>>;
    expect(responses["200"]).toMatchObject({
      content: { "application/json": { schema: binding.operation.outputSchema } },
    });
    // Reviewed errors have no HTTP status; they ride the default response verbatim.
    expect(responses.default?.["x-anvil-legacy-errors"]).toEqual(binding.operation.errors);
    // The wire binding is buildQueueWireBinding's output, never re-derived here.
    expect(op["x-anvil-wire-binding"]).toEqual(buildQueueWireBinding(binding));
    expect(op["x-anvil-effect"]).toBeUndefined();
    expect(op["x-anvil-legacy"]).toMatchObject({
      bindingId: binding.bindingId,
      contentHash: binding.contentHash,
      runtimeStatus: "not_implemented",
      inventoryId: binding.inventoryId,
      candidateId: binding.candidateId,
      receiptId: binding.receiptId,
      operationName: "refunds.submit_refund",
      executable: true,
    });
    expect(openapi["x-anvil-legacy"]).toEqual({
      schemaVersion: 1,
      bindings: [{ bindingId: binding.bindingId, contentHash: binding.contentHash }],
    });
  });

  it("marks a reviewed read with x-anvil-effect and records the conformance report", () => {
    const read = conformantRead();
    const { openapi } = lowerLegacyBindings([read], { title: "Legacy estate" });
    const paths = openapi.paths as Record<string, { post: Record<string, unknown> }>;
    const op = paths[legacyBridgeInvokePath("ledger.read_balance")]?.post as Record<
      string,
      unknown
    >;
    expect(op["x-anvil-effect"]).toBe("read");
    expect(op["x-anvil-legacy"]).toMatchObject({
      runtimeStatus: "conformance_passed",
      conformanceReportHash: REPORT_HASH,
    });
  });

  it("writes a manifest that only ever tightens: blocked until conformant, never approved", () => {
    const { manifest } = lowerLegacyBindings(
      [fixtureLegacyCapabilityBinding(), conformantRead(), conformantMutation()],
      { title: "Legacy estate", serviceId: "legacy" },
    );
    expect(manifest.service).toEqual({ name: "legacy", display_name: "Legacy estate" });
    const operations = manifest.operations as Record<string, Record<string, unknown>>;
    // not_implemented → held blocked, with the reason on the record.
    expect(operations["refunds.submit_refund"]).toMatchObject({ state: "blocked" });
    expect(operations["refunds.submit_refund"]?.review_reason).toContain("not_implemented");
    // conformance_passed → no state at all: the compiler classifies, a human approves.
    expect(operations["ledger.read_balance"]?.state).toBeUndefined();
    expect(operations["ledger.read_balance"]?.review_reason).toContain(REPORT_HASH);
    expect(operations["ledger.read_balance"]?.retries).toBeUndefined();
    expect(operations["ledger.read_balance"]?.idempotency).toBeUndefined();
    // Reviewed `never` retry and `none` idempotency are carried — both tightening.
    expect(operations["refunds.reverse_refund"]).toMatchObject({
      retries: { enabled: false },
      idempotency: { strategy: "none" },
    });
    expect(operations["refunds.reverse_refund"]?.state).toBeUndefined();
    for (const entry of Object.values(operations)) {
      expect(entry.state).not.toBe("approved");
    }
  });

  it("emits a non-executable binding as a visible blocked operation with no wire binding, and reports the refusal", () => {
    const refusedBinding = fireAndForget();
    const result = lowerLegacyBindings([refusedBinding, fixtureLegacyCapabilityBinding()], {
      title: "Legacy estate",
    });
    expect(result.refused).toEqual([
      {
        operationName: "audit.emit_event",
        bindingId: refusedBinding.bindingId,
        reason: expect.stringContaining("declares no reply strategy"),
        emitted: true,
      },
    ]);
    const paths = result.openapi.paths as Record<string, { post: Record<string, unknown> }>;
    const op = paths[legacyBridgeInvokePath("audit.emit_event")]?.post as Record<string, unknown>;
    expect(op["x-anvil-wire-binding"]).toBeUndefined();
    expect(op["x-anvil-legacy"]).toMatchObject({ executable: false });
    const operations = result.manifest.operations as Record<string, Record<string, unknown>>;
    expect(operations["audit.emit_event"]).toMatchObject({ state: "blocked" });
    expect(result.lowered.find((o) => o.operationName === "audit.emit_event")).toMatchObject({
      executable: false,
      manifestState: "blocked",
    });

    const only = lowerLegacyBindings([refusedBinding, fixtureLegacyCapabilityBinding()], {
      title: "Legacy estate",
      executableOnly: true,
    });
    expect(only.refused).toEqual([expect.objectContaining({ emitted: false })]);
    expect(only.lowered.map((o) => o.operationName)).toEqual(["refunds.submit_refund"]);
    expect(Object.keys(only.openapi.paths as object)).toEqual([
      legacyBridgeInvokePath("refunds.submit_refund"),
    ]);
  });

  it("refuses a non-JSON payload encoding as executable — the facade relays bodies verbatim", () => {
    const xml = variant(fixtureLegacyCapabilityBinding(), (core) => ({
      ...core,
      transport:
        core.transport.kind === "message"
          ? { ...core.transport, payloadEncoding: "xml" }
          : core.transport,
    }));
    const { refused, lowered } = lowerLegacyBindings([xml], { title: "Legacy estate" });
    expect(refused[0]?.reason).toContain("'xml' payload encoding");
    expect(lowered[0]).toMatchObject({ executable: false, manifestState: "blocked" });
  });

  it("refuses an empty set, an unverified binding, and two reviews of one operation name", () => {
    expect(() => lowerLegacyBindings([], { title: "x" })).toThrow(LegacyLoweringError);
    const tampered = {
      ...fixtureLegacyCapabilityBinding(),
      contentHash: `sha256:${"0".repeat(64)}`,
    };
    expect(() => lowerLegacyBindings([tampered], { title: "x" })).toThrowError(
      expect.objectContaining({ code: "invalid_binding" }),
    );
    const twice = [
      fixtureLegacyCapabilityBinding(),
      fixtureLegacyCapabilityBinding({ timeoutMs: 999 }),
    ];
    expect(() => lowerLegacyBindings(twice, { title: "x" })).toThrowError(
      expect.objectContaining({ code: "duplicate_operation_name" }),
    );
  });
});

describe("the lowered triad compiles through the ordinary pipeline", () => {
  it("yields queue_request_reply operations the runtime refuses until a facade is declared", async () => {
    const notImplemented = fixtureLegacyCapabilityBinding();
    const passedRead = conformantRead();
    const passedMutation = conformantMutation();
    const refusedBinding = fireAndForget();
    const { openapi, manifest } = lowerLegacyBindings(
      [notImplemented, passedRead, passedMutation, refusedBinding],
      { title: "Legacy estate", serviceId: "legacy" },
    );
    const air = await compile({
      spec: JSON.stringify(openapi),
      manifest: JSON.stringify(manifest),
      serviceId: "legacy",
    });
    const byOperationId = new Map(air.operations.map((op) => [op.sourceRef.operationId, op]));
    expect([...byOperationId.keys()].sort()).toEqual([
      "audit.emit_event",
      "ledger.read_balance",
      "refunds.reverse_refund",
      "refunds.submit_refund",
    ]);

    // not_implemented: present on every surface, blocked, bound to its reviewed content hash.
    const submit = byOperationId.get("refunds.submit_refund");
    expect(submit).toBeDefined();
    if (!submit) return;
    expect(submit.state).toBe("blocked");
    expect(submit.sourceRef.binding).toMatchObject({
      protocol: "queue_request_reply",
      legacyBindingContentHash: notImplemented.contentHash,
    });
    expect(submit.sourceRef.path).toBe(legacyBridgeInvokePath("refunds.submit_refund"));
    expect(submit.sourceRef.method).toBe("post");
    expect(submit.effect.kind).toBe("mutation");
    expect(submit.cli.command).toBe("legacy refunds submit_refund");
    expect(submit.mcp.toolName).toBe("legacy_refunds_submit_refund");
    expect(wireExecutability(submit)).toMatchObject({
      ok: false,
      protocol: "queue_request_reply",
      scope: "coordinates",
    });
    expect(protocolFacadeApplies(submit)).toBe(true);

    // conformance_passed read: not blocked, but not approved either.
    const read = byOperationId.get("ledger.read_balance");
    expect(read).toBeDefined();
    if (!read) return;
    expect(read.state).not.toBe("blocked");
    expect(read.state).not.toBe("approved");
    expect(read.effect.kind).toBe("read");
    expect(read.sourceRef.binding).toMatchObject({
      protocol: "queue_request_reply",
      legacyBindingContentHash: passedRead.contentHash,
    });
    expect(read.reviewNotes.join("\n")).toContain(REPORT_HASH);
    expect(wireExecutability(read).ok).toBe(false);
    expect(protocolFacadeApplies(read)).toBe(true);

    // conformance_passed mutation: the compiler's own review gate, with the
    // reviewed `never` retry and `none` idempotency carried through.
    const reverse = byOperationId.get("refunds.reverse_refund");
    expect(reverse).toBeDefined();
    if (!reverse) return;
    expect(reverse.state).toBe("review_required");
    expect(reverse.retries.mode).toBe("none");
    expect(reverse.idempotency.mode).toBe("none");

    // The refused shape is visible, blocked, and carries no wire binding at all.
    const emit = byOperationId.get("audit.emit_event");
    expect(emit).toBeDefined();
    if (!emit) return;
    expect(emit.state).toBe("blocked");
    expect(emit.sourceRef.binding).toBeUndefined();

    // Nothing lowered is approved: lowering never enables execution.
    expect(air.operations.filter((op) => op.state === "approved")).toEqual([]);
  });
});
