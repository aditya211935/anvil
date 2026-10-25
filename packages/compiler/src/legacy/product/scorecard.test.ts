import { readFileSync } from "node:fs";
import { hashCanonical } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { classifyLegacyTransportShape, legacyAdapterFamily } from "../bridge/index.js";
import type { LegacyCapabilityCandidate } from "../core/index.js";
import { collectLegacyInventory, type LegacySourceMember } from "../inventory.js";
import {
  finalizeLegacyCapabilityBindingRecord,
  type LegacyCapabilityBinding,
  type LegacyTransportPlan,
} from "../refinement/model.js";
import {
  assessLegacyModernization,
  createLegacyCollectionPlan,
  LegacyModernizationScorecard,
  renderLegacyModernizationScorecard,
} from "./index.js";

const encoder = new TextEncoder();

function member(path: string, content: string): LegacySourceMember {
  return { path, bytes: encoder.encode(content) };
}

/** Java EE descriptors with a JNDI conflict plus one AsyncAPI send operation. */
function estate() {
  return collectLegacyInventory({
    estate: { id: "refunds-prod", name: "Refunds (production)" },
    environment: "prod",
    application: "refund-service",
    source: { kind: "deployed_configuration", systemId: "offline-export" },
    members: [
      member(
        "refunds/META-INF/ejb-jar.xml",
        `<ejb-jar><enterprise-beans><session>
          <ejb-name>RefundBean</ejb-name><remote>com.acme.Refunds</remote>
        </session></enterprise-beans></ejb-jar>`,
      ),
      member(
        "refunds/META-INF/weblogic-ejb-jar.xml",
        `<weblogic-ejb-jar><weblogic-enterprise-bean>
          <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v1</jndi-name>
        </weblogic-enterprise-bean></weblogic-ejb-jar>`,
      ),
      member(
        "refunds/META-INF/weblogic-bindings.xml",
        `<weblogic-ejb-jar><weblogic-enterprise-bean>
          <ejb-name>RefundBean</ejb-name><jndi-name>ejb/refunds-v2</jndi-name>
        </weblogic-enterprise-bean></weblogic-ejb-jar>`,
      ),
      member(
        "asyncapi.yaml",
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
      ),
    ],
  });
}

const sha = (digit: string) => `sha256:${digit.repeat(64)}` as const;

function binding(
  inventoryId: string,
  candidate: LegacyCapabilityCandidate,
  transport: LegacyTransportPlan,
  status: "not_implemented" | "conformance_passed" = "not_implemented",
): LegacyCapabilityBinding {
  return finalizeLegacyCapabilityBindingRecord({
    schemaVersion: 1,
    inventoryId,
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
    runtime:
      status === "not_implemented"
        ? { placement: "deployment_local_bridge", status }
        : { placement: "deployment_local_bridge", status, conformanceReportHash: sha("c") },
  });
}

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
  target: "t3://legacy.example.test:7001/ejb/refunds-v1",
  interface: "com.acme.Refunds",
  method: "submit",
  serialization: "java_serialization",
};

describe("assessLegacyModernization", () => {
  it("counts the estate from inventory records only", () => {
    const result = estate();
    const report = assessLegacyModernization(result);

    expect(LegacyModernizationScorecard.parse(report)).toEqual(report);
    expect(report.scorecardId).toMatch(/^lms_[0-9a-f]{64}$/);
    expect(report.estate).toMatchObject({
      id: "refunds-prod",
      name: "Refunds (production)",
      inventoryId: result.snapshot.inventoryId,
      coordinates: 1,
      artifacts: 4,
      safetyRefusals: 0,
    });
    // The AsyncAPI export yields a channel destination and a send operation.
    expect(report.capabilities.total).toBe(3);
    expect(report.capabilities.byInvocationKind).toEqual([
      { key: "message", count: 2 },
      { key: "remote_method", count: 1 },
    ]);
    expect(report.capabilities.byProtocol).toEqual([
      { key: "message/other", count: 2 },
      { key: "remote_method/ejb_rmi", count: 1 },
    ]);
    expect(report.capabilities.withConflicts).toEqual({
      candidates: 1,
      conflicts: 1,
      byDimension: [{ key: "binding_target", count: 1 }],
    });
    expect(report.capabilities.businessSemantics).toEqual({
      unknown: 3,
      asserted_unverified: 0,
      conflicting: 0,
    });
    // Nothing in a descriptor or AsyncAPI export proves these; every candidate lacks them.
    const unknown = new Map(report.capabilities.unknownDimensions.map((e) => [e.key, e.count]));
    expect(unknown.get("business_operation")).toBe(3);
    expect(unknown.get("idempotency")).toBe(3);
    expect(unknown.get("interaction_pattern")).toBe(2);
    expect(unknown.get("technical_name")).toBe(0);
    expect(report.capabilities.unknownDimensions.map((e) => e.count)).toEqual(
      [...report.capabilities.unknownDimensions.map((e) => e.count)].sort((a, b) => b - a),
    );
  });

  it("embeds the coverage report by identity and lists unsatisfied requirements", () => {
    const result = estate();
    const plan = createLegacyCollectionPlan({
      schemaVersion: 1,
      estate: { id: "refunds-prod" },
      sources: [
        {
          id: "prod-config",
          kind: "deployed_configuration",
          systemId: "offline-export",
          root: "exports/prod",
          expectedRoles: ["deployment_descriptor"],
          context: { environment: "prod", application: "refund-service" },
        },
      ],
      requirements: ["deployment_identity", "invocation_binding", "input_schema", "ownership"],
      policy: {
        networkAccess: "deny",
        processExecution: "deny",
        classloading: "deny",
        bytecodeExecution: "deny",
        xmlExternalEntities: "deny",
        secrets: "refuse",
        archiveExpansion: "hardened",
        unknownArtifacts: "report",
        unsupportedEvidence: "fail",
        ambiguousEvidence: "fail",
      },
    });
    const report = assessLegacyModernization(result, { plan });
    expect(report.coverage).toMatchObject({
      planId: plan.planId,
      semanticComplete: false,
      requirements: { satisfied: 2, missing: 2 },
      unsatisfied: ["input_schema", "ownership"],
    });
    expect(report.coverage.reportId).toMatch(/^lcr_[0-9a-f]{64}$/);
    expect(report.blockers.map((b) => b.code)).toEqual([
      "coverage_requirement_unsatisfied",
      "candidate_conflict",
      "business_semantics_unknown",
    ]);
  });

  it("classifies bindings by executable shape and adapter family, with lineage", () => {
    const result = estate();
    const message = result.candidates.find(
      (c) => c.invocation.kind === "message" && c.invocation.direction !== "unknown",
    );
    const ejb = result.candidates.find((c) => c.invocation.kind === "remote_method");
    if (!message || !ejb) throw new Error("fixture must yield both candidates");
    const queue = binding(result.snapshot.inventoryId, message, queueTransport);
    const remote = binding(result.snapshot.inventoryId, ejb, ejbTransport);
    const stale = binding(`li_${"0".repeat(64)}`, ejb, {
      ...ejbTransport,
      protocol: "wcf",
      target: "net.tcp://legacy/refunds",
      serialization: "data_contract",
    });

    const report = assessLegacyModernization(result, { bindings: [stale, remote, queue] });
    expect(report.review).toMatchObject({
      bindingsSupplied: 3,
      candidatesReviewed: 2,
      candidatesUnreviewed: 1,
      byLineage: { matched: 2, unmatched_candidate: 0, stale_inventory: 1, stale_candidate: 0 },
      byRuntimeStatus: { not_implemented: 3, conformance_passed: 0 },
      byShape: { executable_shape: 1, needs_driver: 2 },
      needsDriverFamilies: [
        { key: "WCF", count: 1 },
        { key: "WebLogic remote EJB", count: 1 },
      ],
    });
    const rows = new Map(report.review.bindings.map((row) => [row.bindingId, row]));
    expect(rows.get(queue.bindingId)).toMatchObject({
      shape: "executable_shape",
      lineage: "matched",
      transport: "message/jms",
    });
    expect(rows.get(queue.bindingId)?.family).toBeUndefined();
    expect(rows.get(remote.bindingId)).toMatchObject({
      shape: "needs_driver",
      family: "WebLogic remote EJB",
      lineage: "matched",
    });
    expect(rows.get(stale.bindingId)).toMatchObject({
      shape: "needs_driver",
      family: "WCF",
      lineage: "stale_inventory",
    });
    expect(report.review.bindings.map((row) => row.bindingId)).toEqual(
      [queue, remote, stale].map((b) => b.bindingId).sort(),
    );
    expect(report.blockers.map((b) => [b.code, b.family, b.count])).toEqual([
      ["candidate_conflict", undefined, 1],
      ["business_semantics_unknown", undefined, 3],
      ["binding_lineage_mismatch", undefined, 1],
      ["binding_needs_driver", "WCF", 1],
      ["binding_needs_driver", "WebLogic remote EJB", 1],
      ["binding_not_implemented", undefined, 3],
    ]);
    for (const item of report.blockers) {
      expect(item.nextAction).not.toMatch(/\bready\b|approve this|idempotent\b/i);
    }
  });

  it("is content-addressed and stable across runs", () => {
    const first = assessLegacyModernization(estate());
    const second = assessLegacyModernization(estate());
    expect(second).toEqual(first);
    expect(second.contentHash).toBe(first.contentHash);
    expect(() =>
      LegacyModernizationScorecard.parse({
        ...first,
        capabilities: { ...first.capabilities, total: 99 },
      }),
    ).toThrow(/identity must match/);
  });

  it("renders deterministic Markdown that matches the checked-in expectation", () => {
    const result = estate();
    const message = result.candidates.find((c) => c.invocation.kind === "message");
    const ejb = result.candidates.find((c) => c.invocation.kind === "remote_method");
    if (!message || !ejb) throw new Error("fixture must yield both candidates");
    const report = assessLegacyModernization(result, {
      bindings: [
        binding(result.snapshot.inventoryId, message, queueTransport),
        binding(result.snapshot.inventoryId, ejb, ejbTransport),
      ],
    });
    const markdown = renderLegacyModernizationScorecard(report);
    expect(markdown.startsWith(`# Legacy modernization scorecard \`${report.scorecardId}\``)).toBe(
      true,
    );
    expect(markdown).not.toMatch(/\d{4}-\d{2}-\d{2}|\/home\/|\/tmp\//);
    expect(markdown).toBe(
      readFileSync(new URL("./scorecard.expected.md", import.meta.url), "utf8"),
    );
  });
});

describe("classifyLegacyTransportShape", () => {
  const fixedReply = (reply: Extract<LegacyTransportPlan, { kind: "message" }>["reply"]) =>
    ({ ...queueTransport, reply }) as LegacyTransportPlan;

  it("accepts only correlated reply_to or fixed_destination message transports", () => {
    expect(classifyLegacyTransportShape(queueTransport)).toBe("executable_shape");
    expect(
      classifyLegacyTransportShape(
        fixedReply({ mode: "fixed_destination", target: "jms/Replies", correlationField: "id" }),
      ),
    ).toBe("executable_shape");
    expect(classifyLegacyTransportShape(fixedReply({ mode: "none" }))).toBe("needs_driver");
    expect(
      classifyLegacyTransportShape(fixedReply({ mode: "poll_status", correlationField: "id" })),
    ).toBe("needs_driver");
    expect(classifyLegacyTransportShape(fixedReply({ mode: "reply_to" }))).toBe("needs_driver");
    expect(
      classifyLegacyTransportShape(
        fixedReply({ mode: "fixed_destination", correlationField: "id" }),
      ),
    ).toBe("needs_driver");
    expect(classifyLegacyTransportShape(ejbTransport)).toBe("needs_driver");
  });

  it("names adapter families as the runtime-bridge guide names them", () => {
    expect(legacyAdapterFamily({ ...queueTransport, protocol: "ibm_mq" })).toBe("IBM MQ");
    expect(legacyAdapterFamily({ ...queueTransport, protocol: "msmq" })).toBe("MSMQ");
    expect(legacyAdapterFamily({ ...queueTransport, protocol: "kafka" })).toBe(
      "message broker (kafka)",
    );
    expect(legacyAdapterFamily(ejbTransport)).toBe("WebLogic remote EJB");
    expect(legacyAdapterFamily({ ...ejbTransport, target: "corbaloc:iiop:host:2809" })).toBe(
      "WebSphere remote EJB",
    );
    expect(legacyAdapterFamily({ ...ejbTransport, target: "iiop://host:2809/refunds" })).toBe(
      "WebSphere remote EJB",
    );
    expect(legacyAdapterFamily({ ...ejbTransport, target: "remote+http://host:8080" })).toBe(
      "JBoss remote EJB",
    );
    expect(legacyAdapterFamily({ ...ejbTransport, target: "ejb/refunds-v1" })).toBe("remote EJB");
    expect(
      legacyAdapterFamily({ ...ejbTransport, protocol: "wcf", serialization: "data_contract" }),
    ).toBe("WCF");
    expect(legacyAdapterFamily({ ...ejbTransport, protocol: "rmi" })).toBe("remote method (rmi)");
    expect(
      legacyAdapterFamily({
        kind: "resource_adapter",
        target: "eis/Ledger",
        adapterRef: "ledger.rar",
        connectionFactoryRef: "eis/LedgerCF",
      }),
    ).toBe("JCA resource adapter");
    expect(
      legacyAdapterFamily({
        kind: "stored_procedure",
        target: "jdbc/Ledger",
        databaseRef: "LEDGER",
        procedure: "POST_REFUND",
      }),
    ).toBe("Stored procedure");
    expect(
      legacyAdapterFamily({
        kind: "batch_job",
        target: "scheduler/Nightly",
        schedulerRef: "control-m",
        job: "REFUND_SETTLE",
      }),
    ).toBe("Batch or scheduler");
  });
});
