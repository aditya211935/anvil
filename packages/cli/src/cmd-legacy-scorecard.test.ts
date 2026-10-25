import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashCanonical } from "@anvil/air";
import {
  classifyLegacyTransportShape,
  finalizeLegacyCapabilityBindingRecord,
  type LegacyCapabilityBinding,
  type LegacyCapabilityCandidate,
  type LegacyTransportPlan,
} from "@anvil/compiler/legacy";
import { buildQueueWireBinding } from "@anvil/legacy-bridge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAnvilCli } from "./anvil-cli.js";
import { bufferIO } from "./io.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "anvil-legacy-scorecard-"));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

async function anvil(...argv: string[]) {
  const io = bufferIO();
  const code = await runAnvilCli(argv, { io });
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

interface InventoryReport {
  inventory: { inventoryId: string };
  candidates: LegacyCapabilityCandidate[];
}

async function inventoryReport(): Promise<{ path: string; report: InventoryReport }> {
  const source = join(work, "refunds-prod");
  mkdirSync(join(source, "refunds", "META-INF"), { recursive: true });
  writeFileSync(
    join(source, "refunds", "META-INF", "ejb-jar.xml"),
    `<ejb-jar><enterprise-beans><session>
      <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
    </session></enterprise-beans></ejb-jar>`,
  );
  writeFileSync(
    join(source, "refunds", "META-INF", "weblogic-ejb-jar.xml"),
    `<weblogic-ejb-jar><weblogic-enterprise-bean>
      <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v1</jndi-name>
    </weblogic-enterprise-bean></weblogic-ejb-jar>`,
  );
  writeFileSync(
    join(source, "refunds", "META-INF", "weblogic-bindings.xml"),
    `<weblogic-ejb-jar><weblogic-enterprise-bean>
      <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v2</jndi-name>
    </weblogic-enterprise-bean></weblogic-ejb-jar>`,
  );
  writeFileSync(
    join(source, "asyncapi.yaml"),
    `asyncapi: 3.0.0
info:
  title: Refund events
channels:
  refundCommands:
    address: refunds.commands
operations:
  submitRefund:
    action: send
    channel:
      $ref: '#/channels/refundCommands'
`,
  );
  const path = join(work, "inventory.json");
  const result = await anvil(
    "legacy",
    "inventory",
    source,
    "--environment",
    "prod",
    "--application",
    "refund-service",
    "--out",
    path,
    "--json",
  );
  expect(result.code, result.err).toBe(0);
  return { path, report: JSON.parse(result.out) as InventoryReport };
}

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

const queueTransport: LegacyTransportPlan = {
  kind: "message",
  protocol: "jms",
  target: "jms/RefundRequests",
  direction: "request_reply",
  payloadEncoding: "json",
  reply: { mode: "reply_to", correlationField: "JMSCorrelationID" },
};

const ejbTransport: LegacyTransportPlan = {
  kind: "remote_method",
  protocol: "ejb_rmi",
  target: "ejb/refunds-v1",
  interface: "com.acme.Refunds",
  method: "submit",
  serialization: "java_serialization",
};

function binding(
  report: InventoryReport,
  candidate: LegacyCapabilityCandidate,
  transport: LegacyTransportPlan,
): LegacyCapabilityBinding {
  return finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId: report.inventory.inventoryId,
    inventoryContentHash: sha("2"),
    candidateId: candidate.candidateId,
    candidateHash: `sha256:${hashCanonical(candidate)}`,
    taskId: `lrt_${"5".repeat(64)}`,
    taskHash: sha("6"),
    proposalId: `lrp_${"7".repeat(64)}`,
    proposalHash: sha("8"),
    receiptId: `lrr_${"9".repeat(64)}`,
    receiptHash: sha("a"),
    operation: {
      name: "refunds.submit_refund",
      summary: "Submit a refund",
      description: "Submit one refund request.",
      effect: "create",
      exposure: "mcp_tool",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      errors: [],
    },
    transport,
    semantics: {
      completion: "application_accepted",
      timeoutMs: 1_000,
      authorization: { mode: "bridge_identity", scopes: [] },
      idempotency: { mode: "unknown" },
      retry: { mode: "never", maxAttempts: 1 },
    },
    runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
  });
}

function writeBindings(dir: string, bindings: readonly LegacyCapabilityBinding[]): void {
  mkdirSync(dir, { recursive: true });
  bindings.forEach((item, index) => {
    writeFileSync(join(dir, `binding-${index}.json`), `${JSON.stringify(item)}\n`);
  });
  // A decision report wrapping a binding is accepted too; non-JSON files are ignored.
  writeFileSync(join(dir, "README.txt"), "not a binding\n");
}

describe("anvil legacy scorecard", () => {
  it("emits one JSON report, writes it, and is stable across runs", async () => {
    const { path, report } = await inventoryReport();
    const message = report.candidates.find((c) => c.invocation.kind === "message");
    const ejb = report.candidates.find((c) => c.invocation.kind === "remote_method");
    if (!message || !ejb) throw new Error("fixture must yield both candidates");
    const dir = join(work, "bindings");
    writeBindings(dir, [
      binding(report, message, queueTransport),
      binding(report, ejb, ejbTransport),
    ]);
    const out = join(work, "reports", "scorecard.json");

    const first = await anvil(
      "legacy",
      "scorecard",
      path,
      "--bindings",
      dir,
      "--out",
      out,
      "--json",
    );
    expect(first.code, first.err).toBe(0);
    const envelope = JSON.parse(first.out);
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      reportType: "anvil.legacy-modernization-scorecard",
      scorecard: {
        scorecardId: expect.stringMatching(/^lms_[0-9a-f]{64}$/),
        estate: { id: "refunds-prod", inventoryId: report.inventory.inventoryId },
        capabilities: { total: 3, withConflicts: { candidates: 1 } },
        review: {
          bindingsSupplied: 2,
          candidatesReviewed: 2,
          byShape: { executable_shape: 1, needs_driver: 1 },
          needsDriverFamilies: [{ key: "remote EJB", count: 1 }],
        },
      },
    });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(envelope);

    const second = await anvil(
      "legacy",
      "scorecard",
      path,
      "--bindings",
      dir,
      "--out",
      out,
      "--json",
    );
    expect(second.code, second.err).toBe(0);
    expect(second.out).toBe(first.out);
  });

  it("renders Markdown with --format md and prints a summary otherwise", async () => {
    const { path } = await inventoryReport();
    const out = join(work, "scorecard.md");
    const md = await anvil("legacy", "scorecard", path, "--format", "md", "--out", out);
    expect(md.code, md.err).toBe(0);
    expect(md.out.startsWith("# Legacy modernization scorecard `lms_")).toBe(true);
    expect(md.out).toContain("## Blockers");
    expect(md.out).toContain("| business_semantics_unknown | 3 |");
    expect(md.out).not.toContain(work);
    expect(readFileSync(out, "utf8").trimEnd()).toBe(md.out);

    const summary = await anvil("legacy", "scorecard", path);
    expect(summary.code).toBe(0);
    expect(summary.out).toMatch(/^Legacy modernization scorecard lms_[0-9a-f]{64}\n/);
    expect(summary.out).toContain("3 candidate(s), 1 with conflict(s)");
  });

  it("refuses an unverifiable binding and names the file", async () => {
    const { path } = await inventoryReport();
    const dir = join(work, "bindings");
    mkdirSync(dir);
    writeFileSync(join(dir, "broken.json"), `{"bindingId":"lcb_${"0".repeat(64)}"}\n`);
    const result = await anvil("legacy", "scorecard", path, "--bindings", dir, "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({
      reportType: "anvil.legacy-scorecard-error",
      code: "legacy/scorecard_binding_unverifiable",
      binding: join(dir, "broken.json"),
    });
  });

  it("refuses an unreadable inventory and a bad --format with structured codes", async () => {
    const missing = await anvil("legacy", "scorecard", join(work, "missing.json"), "--json");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.out).code).toBe("legacy/scorecard_input_unreadable");

    const { path } = await inventoryReport();
    const format = await anvil("legacy", "scorecard", path, "--format", "yaml", "--json");
    expect(format.code).toBe(1);
    expect(JSON.parse(format.out).code).toBe("legacy/scorecard_invalid_option");
  });
});

describe("executable_shape agrees with the queue bridge", () => {
  const replies: Extract<LegacyTransportPlan, { kind: "message" }>["reply"][] = [
    { mode: "none" },
    { mode: "reply_to" },
    { mode: "reply_to", correlationField: "JMSCorrelationID" },
    { mode: "reply_to", target: "jms/Replies", correlationField: "JMSCorrelationID" },
    { mode: "fixed_destination" },
    { mode: "fixed_destination", target: "jms/Replies" },
    { mode: "fixed_destination", correlationField: "JMSCorrelationID" },
    { mode: "fixed_destination", target: "jms/Replies", correlationField: "JMSCorrelationID" },
    { mode: "poll_status" },
    { mode: "poll_status", correlationField: "JMSCorrelationID" },
  ];
  const transports: LegacyTransportPlan[] = [
    ...replies.map((reply) => ({ ...queueTransport, reply })),
    ...replies.map((reply) => ({ ...queueTransport, protocol: "ibm_mq" as const, reply })),
    ejbTransport,
    { ...ejbTransport, protocol: "wcf", serialization: "data_contract" },
    {
      kind: "resource_adapter",
      target: "eis/Ledger",
      adapterRef: "ledger.rar",
      connectionFactoryRef: "eis/LedgerCF",
    },
    { kind: "stored_procedure", target: "jdbc/Ledger", databaseRef: "LEDGER", procedure: "POST" },
    { kind: "batch_job", target: "scheduler", schedulerRef: "control-m", job: "SETTLE" },
  ];

  it.each(
    transports.map((transport, index) => [index, transport] as const),
  )("transport %i classifies exactly as buildQueueWireBinding accepts or refuses", (_index, transport) => {
    const candidate = { candidateId: `lc_${"3".repeat(64)}` } as LegacyCapabilityCandidate;
    const reviewed = finalizeLegacyCapabilityBindingRecord({
      schemaVersion: 1,
      inventoryId: `li_${"1".repeat(64)}`,
      inventoryContentHash: sha("2"),
      candidateId: candidate.candidateId,
      candidateHash: sha("4"),
      taskId: `lrt_${"5".repeat(64)}`,
      taskHash: sha("6"),
      proposalId: `lrp_${"7".repeat(64)}`,
      proposalHash: sha("8"),
      receiptId: `lrr_${"9".repeat(64)}`,
      receiptHash: sha("a"),
      operation: {
        name: "refunds.submit_refund",
        summary: "Submit a refund",
        description: "Submit one refund request.",
        effect: "create",
        exposure: "mcp_tool",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        errors: [],
      },
      transport,
      semantics: {
        completion: "application_accepted",
        timeoutMs: 1_000,
        authorization: { mode: "bridge_identity", scopes: [] },
        idempotency: { mode: "unknown" },
        retry: { mode: "never", maxAttempts: 1 },
      },
      runtime: { placement: "deployment_local_bridge", status: "not_implemented" },
    });
    let bridgeAccepts: boolean;
    try {
      buildQueueWireBinding(reviewed);
      bridgeAccepts = true;
    } catch {
      bridgeAccepts = false;
    }
    expect(classifyLegacyTransportShape(transport)).toBe(
      bridgeAccepts ? "executable_shape" : "needs_driver",
    );
  });
});
