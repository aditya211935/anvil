import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "@anvil/compiler";
import {
  finalizeLegacyCapabilityBindingRecord,
  promoteLegacyCapabilityBindingToConformancePassed,
} from "@anvil/compiler/legacy";
import { generateSkill } from "@anvil/generators";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-bridge-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

function writeBinding(): string {
  const binding = finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: `li_${"1".repeat(64)}`,
    inventoryContentHash: `sha256:${"2".repeat(64)}`,
    candidateId: `lc_${"3".repeat(64)}`,
    candidateHash: `sha256:${"4".repeat(64)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: `sha256:${"6".repeat(64)}`,
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: `sha256:${"8".repeat(64)}`,
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: `sha256:${"a".repeat(64)}`,
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submit one refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
      errors: [],
    },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/RefundRequests",
      direction: "produce",
      payloadEncoding: "json",
      reply: { mode: "none" },
    },
    semantics: {
      completion: "transport_accepted",
      timeoutMs: 15_000,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "none" },
      retry: { mode: "never", maxAttempts: 1 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
  const path = join(work, "binding.json");
  writeFileSync(path, `${JSON.stringify(binding)}\n`);
  return path;
}

function writeRequestReplyBinding(): string {
  const binding = finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: `li_${"1".repeat(64)}`,
    inventoryContentHash: `sha256:${"2".repeat(64)}`,
    candidateId: `lc_${"3".repeat(64)}`,
    candidateHash: `sha256:${"4".repeat(64)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: `sha256:${"6".repeat(64)}`,
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: `sha256:${"8".repeat(64)}`,
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: `sha256:${"a".repeat(64)}`,
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submit one refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object", properties: { refundId: { type: "string" } } },
      outputSchema: { type: "object", properties: { accepted: { type: "boolean" } } },
      errors: [],
    },
    transport: {
      kind: "message",
      protocol: "jms",
      target: "jms/RefundRequests",
      direction: "request_reply",
      payloadEncoding: "json",
      reply: { mode: "reply_to", correlationField: "JMSCorrelationID" },
    },
    semantics: {
      completion: "application_accepted",
      timeoutMs: 200,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "client_key", carrier: "refundId" },
      retry: { mode: "safe_transient", maxAttempts: 3 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
  const path = join(work, "rr-binding.json");
  writeFileSync(path, `${JSON.stringify(binding)}\n`);
  return path;
}

describe("anvil legacy bridge plan", () => {
  it("emits a deterministic non-executable plan", async () => {
    const binding = writeBinding();
    const output = join(work, "bridge-plan.json");
    const first = await anvil("legacy", "bridge", "plan", binding, "--out", output, "--json");
    const second = await anvil("legacy", "bridge", "plan", binding, "--out", output, "--json");

    expect(first.code, first.err).toBe(0);
    expect(second).toEqual(first);
    const report = JSON.parse(first.out);
    expect(report).toMatchObject({
      reportType: "anvil.legacy-bridge-plan",
      plan: { executionAllowed: false, operationName: "refunds.submit_refund" },
    });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(report);
  });

  it("fails closed when a driver lacks required capabilities", async () => {
    const descriptor = join(work, "driver.json");
    writeFileSync(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        id: "thin-jms",
        version: "1.0.0",
        transports: [{ kind: "message", protocols: ["jms"] }],
        capabilities: ["transport_client"],
        deterministicGeneration: true,
        liveDiscovery: false,
        acceptsSecrets: false,
      }),
    );
    const result = await anvil(
      "legacy",
      "bridge",
      "plan",
      writeBinding(),
      "--driver",
      descriptor,
      "--json",
    );

    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).driverAssessment).toMatchObject({
      driverId: "thin-jms",
      supported: false,
      missingCapabilities: expect.arrayContaining(["authorization", "recorded_conformance"]),
    });
  });
});

describe("anvil legacy bridge conformance", () => {
  it("passes against the in-process double and promotes the binding, deterministically", async () => {
    const binding = writeRequestReplyBinding();
    const planPath = join(work, "bridge-plan.json");
    const planResult = await anvil(
      "legacy",
      "bridge",
      "plan",
      binding,
      "--out",
      planPath,
      "--json",
    );
    expect(planResult.code, planResult.err).toBe(0);

    const reportPath = join(work, "conformance.json");
    const emitPath = join(work, "promoted-binding.json");
    const first = await anvil(
      "legacy",
      "bridge",
      "conformance",
      planPath,
      "--binding",
      binding,
      "--out",
      reportPath,
      "--emit-binding",
      emitPath,
      "--json",
    );
    expect(first.code, first.err).toBe(0);
    const output = JSON.parse(first.out);
    expect(output.reportType).toBe("anvil.legacy-bridge-conformance");
    expect(output.conformance.brokerDouble).toBe("in_process_double");
    expect(output.conformance.checks.every((c: { status: string }) => c.status === "pass")).toBe(
      true,
    );
    expect(output.promotedBinding.runtime.status).toBe("conformance_passed");
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(output);
    expect(JSON.parse(readFileSync(emitPath, "utf8"))).toEqual(output.promotedBinding);

    const second = await anvil(
      "legacy",
      "bridge",
      "conformance",
      planPath,
      "--binding",
      binding,
      "--json",
    );
    expect(second.code, second.err).toBe(0);
    expect(JSON.parse(second.out).conformance.contentHash).toBe(output.conformance.contentHash);
  });

  it("refuses a plan report with no plan inside it", async () => {
    const binding = writeRequestReplyBinding();
    const emptyPlan = join(work, "empty-plan.json");
    writeFileSync(emptyPlan, JSON.stringify({ plan: null }));
    const result = await anvil(
      "legacy",
      "bridge",
      "conformance",
      emptyPlan,
      "--binding",
      binding,
      "--json",
    );
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).code).toBe("legacy/bridge_plan_missing");
  });
});

describe("anvil legacy bridge lower", () => {
  function writePromotedBinding(dir: string): string {
    const promoted = promoteLegacyCapabilityBindingToConformancePassed(
      JSON.parse(readFileSync(writeRequestReplyBinding(), "utf8")),
      `sha256:${"b".repeat(64)}`,
    );
    const { bindingId: _bindingId, contentHash: _contentHash, ...core } = promoted;
    const renamed = finalizeLegacyCapabilityBindingRecord({
      ...core,
      operation: { ...core.operation, name: "ledger.read_balance", effect: "read" },
    });
    const path = join(dir, "ledger.read_balance.json");
    writeFileSync(path, `${JSON.stringify(renamed)}\n`);
    return path;
  }

  it("lowers a directory of bindings into a spec and manifest that compile into the triad", async () => {
    const dir = join(work, "bindings");
    mkdirSync(dir);
    writePromotedBinding(dir);
    // The fire-and-forget binding (reply mode none) is not executable by the
    // queue bridge; it is still emitted, blocked, so the estate stays visible.
    writeFileSync(join(dir, "produce-only.json"), readFileSync(writeBinding(), "utf8"));
    const spec = join(work, "out", "legacy.openapi.json");
    const manifest = join(work, "out", "legacy.anvil.yaml");
    const args = [
      "legacy",
      "bridge",
      "lower",
      dir,
      "--title",
      "Legacy estate",
      "--service-id",
      "legacy",
      "--out-spec",
      spec,
      "--out-manifest",
      manifest,
      "--json",
    ];
    const first = await anvil(...args);
    expect(first.code, first.err).toBe(0);
    const report = JSON.parse(first.out);
    expect(report).toMatchObject({
      reportType: "anvil.legacy-bridge-lower",
      lowered: [
        {
          operationName: "ledger.read_balance",
          executable: true,
          runtimeStatus: "conformance_passed",
        },
        { operationName: "refunds.submit_refund", executable: false, manifestState: "blocked" },
      ],
      refused: [{ operationName: "refunds.submit_refund", emitted: true }],
    });
    // Deterministic, and the no-overwrite write accepts identical content.
    const second = await anvil(...args);
    expect(second).toEqual(first);

    const openapi = JSON.parse(readFileSync(spec, "utf8"));
    expect(openapi).toEqual(report.openapi);
    const manifestDoc = parseYaml(readFileSync(manifest, "utf8"));
    expect(manifestDoc).toEqual(report.manifest);
    expect(manifestDoc.operations["refunds.submit_refund"].state).toBe("blocked");
    expect(manifestDoc.operations["ledger.read_balance"].state).toBeUndefined();

    const air = await compile({
      spec: readFileSync(spec, "utf8"),
      manifest: readFileSync(manifest, "utf8"),
      serviceId: "legacy",
    });
    const read = air.operations.find((op) => op.sourceRef.operationId === "ledger.read_balance");
    const submit = air.operations.find(
      (op) => op.sourceRef.operationId === "refunds.submit_refund",
    );
    expect(read?.sourceRef.binding?.protocol).toBe("queue_request_reply");
    expect(read?.state).not.toBe("blocked");
    expect(submit?.state).toBe("blocked");
    expect(submit?.sourceRef.binding).toBeUndefined();
    expect(air.operations.some((op) => op.state === "approved")).toBe(false);
    // The skill surface lists every lowered operation in its catalog as pending
    // (not callable) — visible on the surface, with its state beside it.
    const catalog = generateSkill(air)["reference/operations.md"] ?? "";
    expect(catalog).toContain(`\`${read?.cli.command}\``);
    expect(catalog).toContain(`\`${submit?.cli.command}\` — Submit a refund [blocked]`);
    expect(catalog).not.toContain("## Approved operations");
  });

  it("refuses to overwrite a different manifest, a tampered binding, and two reviews of one name", async () => {
    const binding = writeRequestReplyBinding();
    const manifest = join(work, "anvil.yaml");
    writeFileSync(manifest, "operations: {}\n");
    const clash = await anvil(
      "legacy",
      "bridge",
      "lower",
      binding,
      "--title",
      "Legacy estate",
      "--out-manifest",
      manifest,
      "--json",
    );
    expect(clash.code).toBe(1);
    expect(JSON.parse(clash.out).code).toBe("legacy/bridge_output_exists");
    expect(readFileSync(manifest, "utf8")).toBe("operations: {}\n");

    const tampered = join(work, "tampered.json");
    const record = JSON.parse(readFileSync(binding, "utf8"));
    record.operation.summary = "Edited after review";
    writeFileSync(tampered, JSON.stringify(record));
    const invalid = await anvil("legacy", "bridge", "lower", tampered, "--title", "x", "--json");
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.out).code).toBe("legacy/bridge_input_invalid");

    // Two distinct reviewed bindings that name the same operation.
    const duplicate = await anvil(
      "legacy",
      "bridge",
      "lower",
      binding,
      writeBinding(),
      "--title",
      "x",
      "--json",
    );
    expect(duplicate.code).toBe(1);
    expect(JSON.parse(duplicate.out).code).toBe("legacy/bridge_lower_duplicate_operation_name");
  });

  it("omits non-executable bindings under --executable-only but still reports them", async () => {
    const dir = join(work, "bindings");
    mkdirSync(dir);
    writePromotedBinding(dir);
    writeFileSync(join(dir, "produce-only.json"), readFileSync(writeBinding(), "utf8"));
    const result = await anvil(
      "legacy",
      "bridge",
      "lower",
      dir,
      "--title",
      "Legacy estate",
      "--executable-only",
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("1 operation(s) lowered; 1 refused as executable");
    expect(result.out).toContain("refused refunds.submit_refund (omitted)");
    expect(result.out).toContain("never enabled by lowering");
  });
});
