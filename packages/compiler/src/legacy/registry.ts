import { createHash } from "node:crypto";
import {
  createLegacyEvidence,
  createLegacyObservation,
  finalizeLegacyInventory,
  type LegacyArtifactRecord,
  type LegacyCapabilityObservation,
  type LegacyCollectorDiagnostic,
  type LegacyEvidenceRecord,
  LegacyIdentifier,
  reconcileLegacyInventory,
} from "./core/index.js";
import {
  type CollectLegacyInventoryInput,
  collectLegacyInventory,
  LegacyCollectorKind,
  type LegacyInventoryResult,
  legacyDeploymentDigest,
} from "./inventory.js";
import {
  createLegacyCollectorMemberMetadataV2,
  type LegacyCollectionRequirement,
  type LegacyCollectorContextV2,
  LegacyCollectorDescriptorV2,
  type LegacyCollectorEmissionV2,
  LegacyCollectorFactV2,
  type LegacyCollectorMemberV2,
  LegacyCollectorProblemV2,
  type LegacyCollectorV2,
  PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
} from "./product/index.js";

/** A registry refusal: the collector, not the estate, is what is wrong. */
export class LegacyCollectorRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LegacyCollectorRegistryError";
  }
}

export interface LegacyRegistryCollectOptions {
  /** Registered collector ids to run; default every registered collector. */
  collectors?: readonly string[];
  /** Capabilities the collection plan requires, handed to each collector. */
  requiredCapabilities?: readonly LegacyCollectionRequirement[];
}

export interface LegacyCollectorRegistry {
  /** Admit one V2 collector. Refuses a duplicate id, a built-in lane's id, or a
   *  descriptor that does not declare the pure offline boundary. */
  register(collector: LegacyCollectorV2): void;
  /** Descriptors in id order. */
  list(): LegacyCollectorDescriptorV2[];
  /** Run the built-in lanes named by `input.collector`, then every selected
   *  registered collector over the same members, into one inventory. */
  collect(
    input: CollectLegacyInventoryInput,
    options?: LegacyRegistryCollectOptions,
  ): Promise<LegacyInventoryResult>;
}

const BUILT_IN_IDS: ReadonlySet<string> = new Set(LegacyCollectorKind.options);

/**
 * Create an in-process collector registry.
 *
 * This is the SDK seam the V2 collector contract was missing: a way to run an
 * estate's own collectors *inside* `collectLegacyInventory`, so their facts
 * land in the same content-addressed snapshot, under the same deployment
 * coordinate, through the same reconciler, as the built-in lanes. It is a
 * registry, not a plugin loader: callers construct collector objects in their
 * own process and pass them in. Nothing here reads a module path, and the CLI's
 * `--collector` lane list stays closed, so no Anvil command ever loads code from
 * the source tree it is inspecting. The runtime boundary a descriptor declares
 * is a contract this host checks for, not a sandbox it provides.
 */
export function createLegacyCollectorRegistry(): LegacyCollectorRegistry {
  const collectors = new Map<string, LegacyCollectorV2>();

  return {
    register(collector) {
      const parsed = LegacyCollectorDescriptorV2.safeParse(collector.descriptor);
      if (!parsed.success) {
        throw new LegacyCollectorRegistryError(
          "legacy/registry/invalid_descriptor",
          `Collector descriptor is invalid: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ")}`,
        );
      }
      const { id } = parsed.data;
      if (BUILT_IN_IDS.has(id)) {
        throw new LegacyCollectorRegistryError(
          "legacy/registry/reserved_id",
          `Collector id '${id}' names a built-in lane and cannot be registered.`,
        );
      }
      if (collectors.has(id)) {
        throw new LegacyCollectorRegistryError(
          "legacy/registry/duplicate_id",
          `Collector id '${id}' is already registered.`,
        );
      }
      if (parsed.data.runtimeBoundary.mode !== PURE_OFFLINE_COLLECTOR_BOUNDARY_V2.mode) {
        throw new LegacyCollectorRegistryError(
          "legacy/registry/boundary_refused",
          `Collector '${id}' does not declare the pure offline runtime boundary.`,
        );
      }
      collectors.set(id, collector);
    },

    list() {
      return [...collectors.keys()]
        .sort()
        .map((id) => LegacyCollectorDescriptorV2.parse(collectors.get(id)?.descriptor));
    },

    async collect(input, options = {}) {
      const selected = (options.collectors ?? [...collectors.keys()]).map((id) => {
        const collector = collectors.get(id);
        if (!collector) {
          throw new LegacyCollectorRegistryError(
            "legacy/registry/unknown_collector",
            `Collector '${id}' is not registered.`,
          );
        }
        return collector;
      });
      const base = collectLegacyInventory(input);
      if (selected.length === 0) return base;
      return runRegisteredCollectors(base, input, selected, options.requiredCapabilities ?? []);
    },
  };
}

async function runRegisteredCollectors(
  base: LegacyInventoryResult,
  input: CollectLegacyInventoryInput,
  selected: readonly LegacyCollectorV2[],
  requiredCapabilities: readonly LegacyCollectionRequirement[],
): Promise<LegacyInventoryResult> {
  const environment = LegacyIdentifier.parse(input.environment);
  const application = LegacyIdentifier.parse(input.application);
  const deploymentDigest = legacyDeploymentDigest(input.members);
  const artifactsByPath = new Map(base.snapshot.artifacts.map((a) => [a.path, a]));
  const bytesByPath = new Map(input.members.map((member) => [member.path, member.bytes]));

  const evidenceById = new Map<string, LegacyEvidenceRecord>(
    base.snapshot.evidence.map((record) => [record.evidenceId, record]),
  );
  const observations: LegacyCapabilityObservation[] = [...base.snapshot.observations];
  const diagnostics: LegacyCollectorDiagnostic[] = [...base.snapshot.diagnostics];
  const runs = [...base.collectors];

  for (const collector of [...selected].sort((a, b) =>
    a.descriptor.id.localeCompare(b.descriptor.id),
  )) {
    const descriptor = LegacyCollectorDescriptorV2.parse(collector.descriptor);
    const context: LegacyCollectorContextV2 = {
      collectionContext: { environment, application },
      requiredCapabilities,
      runtimeBoundary: PURE_OFFLINE_COLLECTOR_BOUNDARY_V2,
      deploymentDigest,
    };
    const members = memberViews(base.snapshot.artifacts, bytesByPath, descriptor).filter(
      (member) => collector.detect(member, context).length > 0,
    );
    const artifactByMemberId = new Map(
      members.map((member) => [member.memberId, artifactsByPath.get(member.path)]),
    );
    const observationsBefore = observations.length;
    const diagnosticsBefore = diagnostics.length;

    if (members.length > 0) {
      let facts = 0;
      for await (const emission of collector.collect(toAsync(members), context)) {
        const outcome = normalizeEmission(emission, {
          descriptor,
          environment,
          application,
          deploymentDigest,
          artifactByMemberId,
          evidenceById,
        });
        if (outcome.diagnostic) diagnostics.push(outcome.diagnostic);
        if (outcome.observation) {
          facts += 1;
          if (facts > descriptor.limits.maxOutputFacts) {
            diagnostics.push({
              level: "error",
              code: "legacy/registry/fact_limit_exceeded",
              message: `Collector '${descriptor.id}' emitted more than its declared ${descriptor.limits.maxOutputFacts} facts; the rest were not recorded.`,
              collectorId: descriptor.id,
            });
            break;
          }
          observations.push(outcome.observation);
        }
      }
    }
    runs.push({
      collector: descriptor.id,
      inputMembers: members.length,
      observations: observations.length - observationsBefore,
      diagnostics: diagnostics.length - diagnosticsBefore,
    });
  }

  const snapshot = finalizeLegacyInventory({
    schemaVersion: 1,
    estate: base.snapshot.estate,
    artifacts: base.snapshot.artifacts,
    evidence: [...evidenceById.values()],
    observations,
    diagnostics,
  });
  return {
    snapshot,
    candidates: reconcileLegacyInventory(snapshot),
    collectors: runs.sort((a, b) => a.collector.localeCompare(b.collector)),
  };
}

function memberViews(
  artifacts: readonly LegacyArtifactRecord[],
  bytesByPath: ReadonlyMap<string, Uint8Array>,
  descriptor: LegacyCollectorDescriptorV2,
): LegacyCollectorMemberV2[] {
  const extensions = descriptor.accepts.extensions.map((ext) => ext.toLowerCase());
  const roles = new Set(descriptor.accepts.artifactRoles);
  const sourceKinds = new Set(descriptor.accepts.sourceKinds);
  return artifacts.flatMap((artifact) => {
    const bytes = bytesByPath.get(artifact.path);
    if (!bytes || bytes.byteLength > descriptor.limits.maxMemberBytes) return [];
    if (!roles.has(artifact.role) || !sourceKinds.has(artifact.source.kind)) return [];
    const lower = artifact.path.toLowerCase();
    if (extensions.length > 0 && !extensions.some((ext) => lower.endsWith(ext))) return [];
    const metadata = createLegacyCollectorMemberMetadataV2({
      sourceId: artifact.source.systemId,
      path: artifact.path,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      bytes: bytes.byteLength,
      role: artifact.role,
      sourceKind: artifact.source.kind,
      mediaType: artifact.mediaType,
    });
    // A read-only view: a collector may not mutate the caller's bytes.
    return [{ ...metadata, content: bytes.slice() }];
  });
}

async function* toAsync<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

interface NormalizeContext {
  descriptor: LegacyCollectorDescriptorV2;
  environment: string;
  application: string;
  deploymentDigest: string;
  artifactByMemberId: ReadonlyMap<string, LegacyArtifactRecord | undefined>;
  evidenceById: Map<string, LegacyEvidenceRecord>;
}

function normalizeEmission(
  emission: LegacyCollectorEmissionV2,
  ctx: NormalizeContext,
): { observation?: LegacyCapabilityObservation; diagnostic?: LegacyCollectorDiagnostic } {
  const collectorId = ctx.descriptor.id;
  if (emission.kind === "problem") {
    const parsed = LegacyCollectorProblemV2.safeParse(emission.problem);
    if (!parsed.success || parsed.data.collectorId !== collectorId) {
      return {
        diagnostic: refused(collectorId, "problem", "did not verify or named another collector"),
      };
    }
    const problem = parsed.data;
    const artifact = problem.memberId ? ctx.artifactByMemberId.get(problem.memberId) : undefined;
    return {
      diagnostic: {
        level: problem.severity,
        code: problem.code,
        message: problem.message,
        collectorId,
        ...(problem.remediation ? { remediation: problem.remediation } : {}),
        ...(artifact ? { artifactId: artifact.artifactId } : {}),
      },
    };
  }

  const parsed = LegacyCollectorFactV2.safeParse(emission.fact);
  if (!parsed.success || parsed.data.collectorId !== collectorId) {
    return {
      diagnostic: refused(collectorId, "fact", "did not verify or named another collector"),
    };
  }
  const fact = parsed.data;
  if (
    fact.coordinate.environment !== ctx.environment ||
    fact.coordinate.application !== ctx.application ||
    fact.coordinate.deploymentDigest !== ctx.deploymentDigest
  ) {
    return {
      diagnostic: {
        level: "error",
        code: "legacy/registry/coordinate_mismatch",
        message: `Collector '${collectorId}' emitted a fact for another deployment coordinate; it was not recorded. Facts must carry the context's environment, application, and deploymentDigest.`,
        collectorId,
      },
    };
  }

  const evidenceIdFor = new Map<string, string>();
  for (const reference of fact.evidence) {
    const artifact = ctx.artifactByMemberId.get(reference.memberId);
    if (!artifact) {
      return {
        diagnostic: {
          level: "error",
          code: "legacy/registry/unknown_member",
          message: `Collector '${collectorId}' cited a member it was not given; the fact was not recorded.`,
          collectorId,
        },
      };
    }
    const record = createLegacyEvidence({
      schemaVersion: 1,
      artifactId: artifact.artifactId,
      sourceKind: artifact.source.kind,
      collectorId,
      basis: reference.basis,
      coordinate: {
        path: artifact.path,
        ...(reference.pointer ? { pointer: reference.pointer } : {}),
        ...(reference.span ? { span: reference.span } : {}),
      },
    });
    ctx.evidenceById.set(record.evidenceId, record);
    evidenceIdFor.set(referenceKey(reference), record.evidenceId);
  }
  const lookup = (reference: (typeof fact.evidence)[number]) =>
    evidenceIdFor.get(referenceKey(reference)) ?? "";
  const observation = createLegacyObservation({
    schemaVersion: 1,
    collectorId,
    coordinate: fact.coordinate,
    invocation: fact.invocation,
    claims: fact.claims.map((claim) => ({
      dimension: claim.dimension,
      value: claim.value,
      basis: claim.basis,
      evidenceIds: claim.evidence.map(lookup),
    })),
    evidenceIds: fact.evidence.map(lookup),
  });
  return { observation };
}

function referenceKey(reference: {
  memberId: string;
  basis: string;
  pointer?: string;
  span?: { start: number; end: number };
}): string {
  return JSON.stringify([
    reference.memberId,
    reference.basis,
    reference.pointer ?? null,
    reference.span ? [reference.span.start, reference.span.end] : null,
  ]);
}

function refused(collectorId: string, kind: string, why: string): LegacyCollectorDiagnostic {
  return {
    level: "error",
    code: "legacy/registry/emission_refused",
    message: `Collector '${collectorId}' emitted a ${kind} that ${why}; it was not recorded.`,
    collectorId,
  };
}
