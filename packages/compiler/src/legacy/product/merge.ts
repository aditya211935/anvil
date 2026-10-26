import { hashCanonical } from "@anvil/air";
import {
  finalizeLegacyInventory,
  type LegacyCapabilityCandidate,
  type LegacyClaimDimension,
  type LegacyClaimValue,
  type LegacyCollectorDiagnostic,
  type LegacyDeploymentCoordinate,
  LegacyEstate,
  type LegacyInventoryDraft,
  type LegacyInventorySnapshot,
  reconcileLegacyInventory,
  verifyLegacyInventory,
} from "../core/index.js";
import {
  type LegacyLogicalCapabilityId,
  type LegacyOccurrenceId,
  legacyLogicalCapabilityId,
  legacyOccurrenceId,
} from "./identity.js";

export const LEGACY_MERGE_SOURCE_CODE = "legacy/merge/source";
export const LEGACY_MERGE_DISAGREEMENT_CODE = "legacy/merge/cross_source_disagreement";

/**
 * Dimensions where two deployments of the same logical capability asserting
 * different values changes what a bridge may safely do, not merely how it is
 * labelled. Divergence here is warned about in the merged snapshot itself.
 */
export const LEGACY_MERGE_SAFETY_DIMENSIONS: readonly LegacyClaimDimension[] = [
  "binding_target",
  "delivery_guarantee",
  "error_semantics",
  "idempotency",
  "transaction_boundary",
];

export class LegacyMergeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LegacyMergeError";
  }
}

export interface LegacyMergeOptions {
  /** Names the merged estate; required when the inputs do not already agree. */
  estate?: { id: string; name?: string };
}

export interface LegacyMergeSourceCoordinate {
  environment: string;
  application: string;
}

export interface LegacyMergeSource {
  inventoryId: string;
  estate: LegacyEstate;
  coordinates: LegacyMergeSourceCoordinate[];
  artifacts: number;
  evidence: number;
  observations: number;
}

export type LegacyMergeAgreement = "consistent" | "divergent" | "single_occurrence";

export interface LegacyMergeLineageOccurrence {
  occurrenceId: LegacyOccurrenceId;
  candidateId: string;
  coordinate: LegacyDeploymentCoordinate;
}

export interface LegacyMergeLineageDimension {
  dimension: LegacyClaimDimension;
  state: "consistent" | "divergent";
  /** Every distinct value asserted for this dimension anywhere in the lineage. */
  values: LegacyClaimValue[];
  /** Occurrences that assert the dimension at all; absence is unknown, not disagreement. */
  assertedBy: LegacyOccurrenceId[];
}

export interface LegacyMergeLineage {
  logicalCapabilityId: LegacyLogicalCapabilityId;
  agreement: LegacyMergeAgreement;
  divergentDimensions: LegacyClaimDimension[];
  occurrences: LegacyMergeLineageOccurrence[];
  dimensions: LegacyMergeLineageDimension[];
}

export interface LegacyMergeResult {
  snapshot: LegacyInventorySnapshot;
  candidates: LegacyCapabilityCandidate[];
  lineages: LegacyMergeLineage[];
  sources: LegacyMergeSource[];
}

const MAX_COORDINATES_IN_MESSAGE = 4;

/**
 * Merge several verified inventories of one estate into one snapshot.
 *
 * Records are unioned by their content-addressed ids, so the same bytes
 * captured twice collapse while two exports that disagree about a path both
 * survive. No claim is dropped or chosen: the existing reconciler sees every
 * observation and keeps surfacing conflicts exactly as it does for a single
 * export. Cross-coordinate disagreement is reported one level up, per logical
 * capability, as a lineage and a warning diagnostic in the snapshot itself.
 *
 * The result is order-independent, and merging a snapshot with itself is the
 * identity, because a single (deduplicated) input is returned re-verified.
 */
export function mergeLegacyInventories(
  inputs: readonly LegacyInventorySnapshot[],
  options: LegacyMergeOptions = {},
): LegacyMergeResult {
  if (inputs.length === 0) {
    throw new LegacyMergeError(
      "legacy/merge/no_inputs",
      "Refused to merge zero legacy inventories; supply at least one verified snapshot.",
    );
  }
  const verified = dedupeByInventoryId(inputs.map((input) => verifyLegacyInventory(input)));
  const estate = resolveEstate(verified, options);
  const sources = verified.map(describeSource);

  if (verified.length === 1 && verified[0]) {
    const only = verified[0];
    const snapshot =
      hashCanonical(only.estate) === hashCanonical(estate)
        ? only
        : finalizeLegacyInventory({ ...draftOf(only), estate });
    const candidates = reconcileLegacyInventory(snapshot);
    return { snapshot, candidates, lineages: lineagesOf(estate, candidates), sources };
  }

  const draft: LegacyInventoryDraft = {
    schemaVersion: 1,
    estate,
    artifacts: unionById(verified, (snapshot) => snapshot.artifacts, "artifactId"),
    evidence: unionById(verified, (snapshot) => snapshot.evidence, "evidenceId"),
    observations: unionById(verified, (snapshot) => snapshot.observations, "observationId"),
    diagnostics: unionDiagnostics([
      ...verified.flatMap((snapshot) => snapshot.diagnostics),
      ...sources.map(sourceDiagnostic),
    ]),
  };

  const interim = finalizeLegacyInventory(draft);
  const lineages = lineagesOf(estate, reconcileLegacyInventory(interim));
  const snapshot = finalizeLegacyInventory({
    ...draft,
    diagnostics: unionDiagnostics([
      ...draft.diagnostics,
      ...lineages.flatMap((lineage) => disagreementDiagnostics(lineage)),
    ]),
  });
  return { snapshot, candidates: reconcileLegacyInventory(snapshot), lineages, sources };
}

function dedupeByInventoryId(
  snapshots: readonly LegacyInventorySnapshot[],
): LegacyInventorySnapshot[] {
  const byId = new Map<string, LegacyInventorySnapshot>();
  for (const snapshot of snapshots) byId.set(snapshot.inventoryId, snapshot);
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, snapshot]) => snapshot);
}

function resolveEstate(
  snapshots: readonly LegacyInventorySnapshot[],
  options: LegacyMergeOptions,
): LegacyEstate {
  if (options.estate) return LegacyEstate.parse(options.estate);
  const distinct = new Map<string, LegacyEstate>();
  for (const snapshot of snapshots) distinct.set(hashCanonical(snapshot.estate), snapshot.estate);
  const estates = [...distinct.values()];
  const first = estates[0];
  if (estates.length === 1 && first) return first;
  const named = estates
    .map((estate) => (estate.name ? `${estate.id} (${estate.name})` : estate.id))
    .sort()
    .join(", ");
  throw new LegacyMergeError(
    "legacy/merge/estate_mismatch",
    `Refused to merge inventories from different estates: ${named}. Name the merged estate explicitly to assert that they describe one estate.`,
  );
}

function draftOf(snapshot: LegacyInventorySnapshot): LegacyInventoryDraft {
  return {
    schemaVersion: 1,
    estate: snapshot.estate,
    artifacts: snapshot.artifacts,
    evidence: snapshot.evidence,
    observations: snapshot.observations,
    diagnostics: snapshot.diagnostics,
  };
}

function unionById<T extends object, K extends keyof T>(
  snapshots: readonly LegacyInventorySnapshot[],
  select: (snapshot: LegacyInventorySnapshot) => readonly T[],
  key: K,
): T[] {
  const byId = new Map<string, T>();
  for (const snapshot of snapshots) {
    for (const record of select(snapshot)) byId.set(String(record[key]), record);
  }
  return [...byId.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record);
}

function unionDiagnostics(
  diagnostics: readonly LegacyCollectorDiagnostic[],
): LegacyCollectorDiagnostic[] {
  const byContent = new Map<string, LegacyCollectorDiagnostic>();
  for (const diagnostic of diagnostics) byContent.set(hashCanonical(diagnostic), diagnostic);
  return [...byContent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, diagnostic]) => diagnostic);
}

function describeSource(snapshot: LegacyInventorySnapshot): LegacyMergeSource {
  const coordinates = new Map<string, LegacyMergeSourceCoordinate>();
  for (const observation of snapshot.observations) {
    const { environment, application } = observation.coordinate;
    coordinates.set(`${environment}/${application}`, { environment, application });
  }
  return {
    inventoryId: snapshot.inventoryId,
    estate: snapshot.estate,
    coordinates: [...coordinates.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, coordinate]) => coordinate),
    artifacts: snapshot.artifacts.length,
    evidence: snapshot.evidence.length,
    observations: snapshot.observations.length,
  };
}

function coordinateList(coordinates: readonly LegacyMergeSourceCoordinate[]): string {
  if (coordinates.length === 0) return "no deployment coordinates";
  const shown = coordinates
    .slice(0, MAX_COORDINATES_IN_MESSAGE)
    .map((coordinate) => `${coordinate.environment}/${coordinate.application}`);
  const more = coordinates.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function sourceDiagnostic(source: LegacyMergeSource): LegacyCollectorDiagnostic {
  return {
    level: "info",
    code: LEGACY_MERGE_SOURCE_CODE,
    message: `Merged source inventory ${source.inventoryId}: ${source.artifacts} artifact(s), ${source.evidence} evidence record(s), ${source.observations} observation(s) at ${coordinateList(source.coordinates)}.`,
  };
}

function disagreementDiagnostics(lineage: LegacyMergeLineage): LegacyCollectorDiagnostic[] {
  const divergent = lineage.divergentDimensions.filter((dimension) =>
    LEGACY_MERGE_SAFETY_DIMENSIONS.includes(dimension),
  );
  if (divergent.length === 0) return [];
  const coordinates = lineage.occurrences.map((occurrence) => ({
    environment: occurrence.coordinate.environment,
    application: occurrence.coordinate.application,
  }));
  return [
    {
      level: "warning",
      code: LEGACY_MERGE_DISAGREEMENT_CODE,
      message: `Logical capability ${lineage.logicalCapabilityId} has ${lineage.occurrences.length} deployment occurrence(s) at ${coordinateList(coordinates)} that disagree on ${divergent.join(", ")}.`,
      remediation:
        "Explain each occurrence and review the disagreement before refinement; the merge keeps every value and never selects one source as authoritative.",
    },
  ];
}

interface DimensionAccumulator {
  valueSets: Map<LegacyOccurrenceId, string>;
  values: Map<string, LegacyClaimValue>;
}

function lineagesOf(
  estate: LegacyEstate,
  candidates: readonly LegacyCapabilityCandidate[],
): LegacyMergeLineage[] {
  const groups = new Map<LegacyLogicalCapabilityId, LegacyCapabilityCandidate[]>();
  for (const candidate of candidates) {
    const logicalId = legacyLogicalCapabilityId(estate, candidate);
    groups.set(logicalId, [...(groups.get(logicalId) ?? []), candidate]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([logicalCapabilityId, members]) => lineageOf(logicalCapabilityId, members));
}

function lineageOf(
  logicalCapabilityId: LegacyLogicalCapabilityId,
  members: readonly LegacyCapabilityCandidate[],
): LegacyMergeLineage {
  const occurrences: LegacyMergeLineageOccurrence[] = members
    .map((candidate) => ({
      occurrenceId: legacyOccurrenceId(candidate),
      candidateId: candidate.candidateId,
      coordinate: candidate.coordinate,
    }))
    .sort((left, right) => left.occurrenceId.localeCompare(right.occurrenceId));

  const accumulators = new Map<LegacyClaimDimension, DimensionAccumulator>();
  for (const candidate of members) {
    const occurrenceId = legacyOccurrenceId(candidate);
    for (const claim of candidate.claims) {
      const accumulator = accumulators.get(claim.dimension) ?? {
        valueSets: new Map(),
        values: new Map(),
      };
      const keys = claim.assertions.map((assertion) => hashCanonical(assertion.value)).sort();
      for (const assertion of claim.assertions) {
        accumulator.values.set(hashCanonical(assertion.value), assertion.value);
      }
      accumulator.valueSets.set(occurrenceId, hashCanonical(keys));
      accumulators.set(claim.dimension, accumulator);
    }
  }

  const dimensions: LegacyMergeLineageDimension[] = [...accumulators.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dimension, accumulator]) => {
      const assertedBy = [...accumulator.valueSets.keys()].sort();
      const distinctSets = new Set(accumulator.valueSets.values());
      return {
        dimension,
        state: distinctSets.size > 1 ? "divergent" : "consistent",
        values: [...accumulator.values.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, value]) => value),
        assertedBy,
      };
    });
  const divergentDimensions = dimensions
    .filter((dimension) => dimension.state === "divergent")
    .map((dimension) => dimension.dimension);
  const agreement: LegacyMergeAgreement =
    occurrences.length === 1
      ? "single_occurrence"
      : divergentDimensions.length > 0
        ? "divergent"
        : "consistent";
  return { logicalCapabilityId, agreement, divergentDimensions, occurrences, dimensions };
}
