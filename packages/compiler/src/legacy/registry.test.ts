import { describe, expect, it } from "vitest";
import { collectLegacyInventory, type LegacySourceMember } from "./inventory.js";
import {
  createLegacyCollectorFactV2,
  createLegacyCollectorProblemV2,
  type LegacyCollectorContextV2,
  type LegacyCollectorDescriptorV2,
  type LegacyCollectorMemberV2,
  type LegacyCollectorV2,
  PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
  verifyLegacyProductInput,
} from "./product/index.js";
import { createLegacyCollectorRegistry, LegacyCollectorRegistryError } from "./registry.js";

const encoder = new TextEncoder();
const member = (path: string, content: string): LegacySourceMember => ({
  path,
  bytes: encoder.encode(content),
});

const descriptor: LegacyCollectorDescriptorV2 = {
  apiVersion: "anvil.dev/legacy-collector/v2",
  id: "acme-scheduler",
  version: "1.0.0",
  displayName: "Acme scheduler export",
  runtimeBoundary: PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
  accepts: {
    sourceKinds: ["deployed_configuration"],
    artifactRoles: ["runtime_configuration", "other"],
    extensions: [".sched"],
    mediaTypes: [],
  },
  capabilities: ["invocation_binding"],
  limits: { maxMemberBytes: 1024 * 1024, maxMembers: 100, maxOutputFacts: 2 },
};

/** A deterministic collector: every `JOB <name>` line in a .sched file is a batch job. */
function schedulerCollector(options: { wrongDigest?: boolean; overflow?: boolean } = {}) {
  const collector: LegacyCollectorV2 = {
    descriptor,
    detect(m) {
      return m.path.endsWith(".sched")
        ? [
            {
              collectorId: descriptor.id,
              memberId: m.memberId,
              artifactFamily: "acme-sched",
              confidence: "exact",
              reason: "extension",
            },
          ]
        : [];
    },
    plan() {
      return [];
    },
    async *collect(members: AsyncIterable<LegacyCollectorMemberV2>, ctx: LegacyCollectorContextV2) {
      for await (const m of members) {
        const text = new TextDecoder().decode(m.content);
        const jobs = [...text.matchAll(/^JOB (\S+)/gm)].map((match) => match[1] ?? "");
        const names = options.overflow ? [...jobs, "x1", "x2", "x3"] : jobs;
        for (const job of names) {
          const evidence = [
            { memberId: m.memberId, basis: "declared" as const, pointer: `/job/${job}` },
          ];
          yield {
            kind: "fact" as const,
            fact: createLegacyCollectorFactV2({
              schemaVersion: 2,
              collectorId: descriptor.id,
              coordinate: {
                environment: ctx.collectionContext.environment,
                platform: "acme-scheduler",
                application: ctx.collectionContext.application,
                module: "schedules",
                component: m.path,
                deploymentDigest: options.wrongDigest
                  ? `sha256:${"0".repeat(64)}`
                  : (ctx.deploymentDigest ?? `sha256:${"0".repeat(64)}`),
              },
              invocation: { kind: "batch_job", schedulerRef: "acme", job },
              evidence,
              claims: [{ dimension: "technical_name", value: job, basis: "declared", evidence }],
            }),
          };
        }
        if (text.includes("PASSWORD")) {
          yield {
            kind: "problem" as const,
            problem: createLegacyCollectorProblemV2({
              schemaVersion: 2,
              collectorId: descriptor.id,
              stage: "collect",
              category: "safety_refusal",
              severity: "warning",
              code: "legacy/acme/secret_like_value",
              message: "A credential-like token was present and not recorded.",
              memberId: m.memberId,
              evidenceIds: [],
              retryable: false,
            }),
          };
        }
      }
    },
  };
  return collector;
}

const input = {
  estate: { id: "ops" },
  environment: "prod",
  application: "nightly",
  source: { kind: "deployed_configuration" as const, systemId: "sched-export" },
  members: [
    member("jobs/nightly.sched", "JOB settle\nJOB reconcile PASSWORD=x\n"),
    member(
      "refunds/META-INF/ejb-jar.xml",
      `<ejb-jar><enterprise-beans><session><ejb-name>R</ejb-name><remote>com.acme.R</remote></session></enterprise-beans></ejb-jar>`,
    ),
  ],
};

describe("legacy collector registry", () => {
  it("refuses built-in ids, duplicates, and non-offline boundaries", () => {
    const registry = createLegacyCollectorRegistry();
    expect(() =>
      registry.register({
        ...schedulerCollector(),
        descriptor: { ...descriptor, id: "messaging" },
      }),
    ).toThrow(LegacyCollectorRegistryError);
    registry.register(schedulerCollector());
    expect(() => registry.register(schedulerCollector())).toThrow(/already registered/);
    expect(() =>
      registry.register({
        ...schedulerCollector(),
        descriptor: {
          ...descriptor,
          id: "other",
          runtimeBoundary: { ...PURE_OFFLINE_COLLECTOR_BOUNDARY_V2, networkAccess: true },
        },
      }),
    ).toThrow(LegacyCollectorRegistryError);
    expect(registry.list().map((d) => d.id)).toEqual(["acme-scheduler"]);
  });

  it("lands registered facts in the same snapshot and coordinate as the built-in lanes", async () => {
    const registry = createLegacyCollectorRegistry();
    registry.register(schedulerCollector());
    const result = await registry.collect(input);
    const base = collectLegacyInventory(input);

    const kinds = result.candidates.map((c) => c.invocation.kind).sort();
    expect(kinds).toEqual(["batch_job", "batch_job", "remote_method"]);
    const jobs = result.snapshot.observations.filter((o) => o.collectorId === "acme-scheduler");
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((o) => o.coordinate.deploymentDigest))).toEqual(
      new Set(base.snapshot.observations.map((o) => o.coordinate.deploymentDigest)),
    );
    expect(result.snapshot.artifacts).toEqual(base.snapshot.artifacts);
    expect(result.collectors.map((r) => r.collector)).toEqual(["acme-scheduler", "java-ee"]);
    expect(result.snapshot.diagnostics.map((d) => d.code)).toContain(
      "legacy/acme/secret_like_value",
    );
    // The product projections accept the merged result as a verified inventory.
    expect(() => verifyLegacyProductInput(result)).not.toThrow();
    // Deterministic across runs.
    const again = await registry.collect(input);
    expect(again.snapshot.contentHash).toBe(result.snapshot.contentHash);
  });

  it("drops facts that name another deployment coordinate and enforces the fact limit", async () => {
    const wrong = createLegacyCollectorRegistry();
    wrong.register(schedulerCollector({ wrongDigest: true }));
    const mismatched = await wrong.collect(input);
    expect(mismatched.candidates.map((c) => c.invocation.kind)).toEqual(["remote_method"]);
    expect(
      mismatched.snapshot.diagnostics.filter(
        (d) => d.code === "legacy/registry/coordinate_mismatch",
      ),
    ).toHaveLength(2);

    const overflow = createLegacyCollectorRegistry();
    overflow.register(schedulerCollector({ overflow: true }));
    const capped = await overflow.collect(input);
    expect(
      capped.snapshot.observations.filter((o) => o.collectorId === "acme-scheduler"),
    ).toHaveLength(2);
    expect(capped.snapshot.diagnostics.map((d) => d.code)).toContain(
      "legacy/registry/fact_limit_exceeded",
    );
  });

  it("runs only the selected collectors and refuses unknown ids", async () => {
    const registry = createLegacyCollectorRegistry();
    registry.register(schedulerCollector());
    await expect(registry.collect(input, { collectors: ["nope"] })).rejects.toThrow(
      /not registered/,
    );
    const none = await registry.collect(input, { collectors: [] });
    expect(none.collectors.map((r) => r.collector)).toEqual(["java-ee"]);
  });
});
