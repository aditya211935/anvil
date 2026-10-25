import { hashCanonical } from "@anvil/air";
import { z } from "zod";
import { classifyLegacyTransportShape, legacyAdapterFamily } from "../bridge/shape.js";
import {
  type LegacyCapabilityCandidate,
  LegacyClaimDimension,
  LegacyIdentifier,
  type LegacyInvocation,
  LegacySha256,
} from "../core/index.js";
import type { LegacyInventoryResult } from "../inventory.js";
import {
  LegacyCapabilityBinding,
  type LegacyCapabilityBinding as LegacyCapabilityBindingType,
} from "../refinement/model.js";
import type { LegacyCollectionPlan } from "./collection-plan.js";
import { LegacyCollectionRequirement } from "./collection-plan.js";
import { assessLegacyCoverage, isLegacySafetyRefusal } from "./coverage.js";
import { type LegacyProductInput, verifyLegacyProductInput } from "./input.js";

const count = z.number().int().nonnegative();
const text = (max = 2048) => z.string().min(1).max(max);

const InvocationKind = z.enum([
  "message",
  "remote_method",
  "resource_adapter",
  "stored_procedure",
  "batch_job",
]);

export const LegacyScorecardBlockerCode = z.enum([
  "safety_refusal",
  "coverage_requirement_unsatisfied",
  "candidate_conflict",
  "business_semantics_unknown",
  "business_semantics_conflicting",
  "binding_lineage_mismatch",
  "binding_needs_driver",
  "binding_not_implemented",
]);
export type LegacyScorecardBlockerCode = z.infer<typeof LegacyScorecardBlockerCode>;

/**
 * The fixed follow-up per blocker code. These are the only "recommendations"
 * a scorecard carries: one sentence per code, naming the existing step that
 * addresses it. None proposes an approval, asserts idempotency, or says that
 * anything is ready.
 */
export const LEGACY_SCORECARD_NEXT_ACTION: Record<LegacyScorecardBlockerCode, string> = {
  safety_refusal:
    "Supply a sanitized, allowlisted export in place of the refused one; `anvil legacy gaps` lists each refusal as a critical gap.",
  coverage_requirement_unsatisfied:
    "Acquire the evidence `anvil legacy gaps` requests for each unsatisfied requirement before refining the affected candidates.",
  candidate_conflict:
    "Resolve each conflicting dimension inside a hash-bound refinement proposal with cited evidence (`anvil legacy refine task`); the inventory keeps the disagreement.",
  business_semantics_unknown:
    "Run one refinement task per candidate; inventory evidence cannot supply business meaning and the scorecard does not infer it.",
  business_semantics_conflicting:
    "Resolve the conflicting business assertions in refinement before review; no candidate with conflicting semantics can be bound.",
  binding_lineage_mismatch:
    "Re-run refinement against this inventory; a binding addressed to another inventory or candidate hash is not a review of this estate.",
  binding_needs_driver:
    "No conformance runner exists for this transport family; the adapter must be built and pass conformance before the binding can be tested.",
  binding_not_implemented:
    "For executable-shape bindings run `anvil legacy bridge plan` then `anvil legacy bridge conformance`; every other binding waits on its adapter family.",
};

const BLOCKER_ORDER: readonly LegacyScorecardBlockerCode[] = LegacyScorecardBlockerCode.options;

const Histogram = <T extends z.ZodTypeAny>(key: T) =>
  z.array(z.object({ key, count }).strict()).max(10_000);

export const LegacyScorecardBlocker = z
  .object({
    code: LegacyScorecardBlockerCode,
    /** Present only for `binding_needs_driver`, naming the adapter family. */
    family: text(256).optional(),
    count,
    detail: text(),
    nextAction: text(),
  })
  .strict();
export type LegacyScorecardBlocker = z.infer<typeof LegacyScorecardBlocker>;

export const LegacyScorecardBinding = z
  .object({
    bindingId: z.string().regex(/^lcb_[0-9a-f]{64}$/),
    candidateId: z.string().regex(/^lc_[0-9a-f]{64}$/),
    operationName: text(128),
    transport: text(64),
    runtimeStatus: z.enum(["not_implemented", "conformance_passed"]),
    shape: z.enum(["executable_shape", "needs_driver"]),
    /** Present only for `needs_driver`. */
    family: text(256).optional(),
    lineage: z.enum(["matched", "unmatched_candidate", "stale_inventory", "stale_candidate"]),
  })
  .strict();
export type LegacyScorecardBinding = z.infer<typeof LegacyScorecardBinding>;

const ScorecardCore = z
  .object({
    schemaVersion: z.literal(1),
    estate: z
      .object({
        id: LegacyIdentifier,
        name: z.string().min(1).max(256).optional(),
        inventoryId: z.string().regex(/^li_[0-9a-f]{64}$/),
        inventoryContentHash: LegacySha256,
        coordinates: count,
        artifacts: count,
        evidence: count,
        observations: count,
        diagnostics: z.object({ error: count, warning: count, info: count }).strict(),
        safetyRefusals: count,
      })
      .strict(),
    capabilities: z
      .object({
        total: count,
        byInvocationKind: Histogram(InvocationKind),
        byProtocol: Histogram(text(64)),
        byDisposition: z.object({ triage: count, review_required: count }).strict(),
        withConflicts: z
          .object({
            candidates: count,
            conflicts: count,
            byDimension: Histogram(LegacyClaimDimension),
          })
          .strict(),
        businessSemantics: z
          .object({ unknown: count, asserted_unverified: count, conflicting: count })
          .strict(),
        unknownDimensions: Histogram(LegacyClaimDimension),
      })
      .strict(),
    coverage: z
      .object({
        reportId: z.string().regex(/^lcr_[0-9a-f]{64}$/),
        contentHash: LegacySha256,
        planId: z
          .string()
          .regex(/^lcp_[0-9a-f]{64}$/)
          .optional(),
        outcome: z.enum(["supported", "partial", "unsupported", "safety-refusal"]),
        semanticComplete: z.boolean(),
        requirements: z
          .object({ satisfied: count, partial: count, missing: count, not_applicable: count })
          .strict(),
        unsatisfied: z.array(LegacyCollectionRequirement).max(64),
      })
      .strict(),
    review: z
      .object({
        bindingsSupplied: count,
        candidatesReviewed: count,
        candidatesUnreviewed: count,
        byLineage: z
          .object({
            matched: count,
            unmatched_candidate: count,
            stale_inventory: count,
            stale_candidate: count,
          })
          .strict(),
        byRuntimeStatus: z.object({ not_implemented: count, conformance_passed: count }).strict(),
        byShape: z.object({ executable_shape: count, needs_driver: count }).strict(),
        needsDriverFamilies: Histogram(text(256)),
        bindings: z.array(LegacyScorecardBinding).max(100_000),
      })
      .strict(),
    blockers: z.array(LegacyScorecardBlocker).max(1_000),
  })
  .strict();

export const LegacyModernizationScorecard = ScorecardCore.extend({
  scorecardId: z.string().regex(/^lms_[0-9a-f]{64}$/),
  contentHash: LegacySha256,
})
  .strict()
  .superRefine((report, ctx) => {
    const { scorecardId: _scorecardId, contentHash: _contentHash, ...core } = report;
    const expected = scorecardAddress(core);
    if (
      report.scorecardId !== expected.scorecardId ||
      report.contentHash !== expected.contentHash
    ) {
      ctx.addIssue({ code: "custom", message: "scorecard identity must match its content" });
    }
  });
export type LegacyModernizationScorecard = z.infer<typeof LegacyModernizationScorecard>;

function scorecardAddress(core: z.infer<typeof ScorecardCore>): {
  scorecardId: string;
  contentHash: `sha256:${string}`;
} {
  const hex = hashCanonical(core);
  return { scorecardId: `lms_${hex}`, contentHash: `sha256:${hex}` };
}

export interface AssessLegacyModernizationOptions {
  /** Verified or unverified reviewed bindings; each is re-verified here. */
  bindings?: readonly LegacyCapabilityBindingType[];
  /** An addressed collection plan; coverage is assessed against its requirements. */
  plan?: LegacyCollectionPlan;
}

function histogram<K extends string>(
  keys: Iterable<K>,
  order: "key" | "count" = "key",
): { key: K; count: number }[] {
  const counts = new Map<K, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, total]) => ({ key, count: total }))
    .sort((left, right) =>
      order === "count" && left.count !== right.count
        ? right.count - left.count
        : left.key.localeCompare(right.key),
    );
}

export function legacyInvocationProtocol(invocation: LegacyInvocation): string {
  return invocation.kind === "message" || invocation.kind === "remote_method"
    ? `${invocation.kind}/${invocation.protocol}`
    : invocation.kind;
}

function transportLabel(binding: LegacyCapabilityBindingType): string {
  const { transport } = binding;
  return transport.kind === "message" || transport.kind === "remote_method"
    ? `${transport.kind}/${transport.protocol}`
    : transport.kind;
}

function blocker(
  code: LegacyScorecardBlockerCode,
  total: number,
  detail: string,
  family?: string,
): LegacyScorecardBlocker[] {
  if (total === 0) return [];
  return [
    LegacyScorecardBlocker.parse({
      code,
      ...(family ? { family } : {}),
      count: total,
      detail,
      nextAction: LEGACY_SCORECARD_NEXT_ACTION[code],
    }),
  ];
}

/**
 * Score an estate's modernization state from its verified inventory, the
 * coverage assessment, and any reviewed bindings. Every number is a count
 * over inventory or binding records; nothing is inferred from names, and the
 * result proposes no approval, asserts no idempotency, and calls nothing
 * ready. `executable_shape` means only that today's queue bridge could
 * conformance-test the transport, never that it runs.
 */
export function assessLegacyModernization(
  input: LegacyProductInput | LegacyInventoryResult,
  options: AssessLegacyModernizationOptions = {},
): LegacyModernizationScorecard {
  const verified = verifyLegacyProductInput(input);
  const { snapshot, candidates } = verified;
  const bindings = [...(options.bindings ?? [])]
    .map((binding) => LegacyCapabilityBinding.parse(binding))
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  const coverage = assessLegacyCoverage(verified, options.plan ? { plan: options.plan } : {});

  const diagnostics = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of snapshot.diagnostics) diagnostics[diagnostic.level] += 1;
  const safetyRefusals = snapshot.diagnostics.filter(isLegacySafetyRefusal).length;

  const candidateById = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const rows = bindings.map((binding) => bindingRow(binding, snapshot.inventoryId, candidateById));
  const reviewedCandidateIds = new Set(
    rows.filter((row) => row.lineage === "matched").map((row) => row.candidateId),
  );
  const needsDriverFamilies = histogram(
    rows.flatMap((row) => (row.family ? [row.family] : [])),
    "count",
  );

  const unsatisfied = coverage.requirements
    .filter((requirement) => requirement.status === "partial" || requirement.status === "missing")
    .map((requirement) => requirement.requirement)
    .sort();
  const conflicting = candidates.filter((candidate) => candidate.conflicts.length > 0);
  const semantics = tally(candidates, (candidate) => candidate.businessSemantics, [
    "unknown",
    "asserted_unverified",
    "conflicting",
  ] as const);
  const lineage = tally(rows, (row) => row.lineage, [
    "matched",
    "unmatched_candidate",
    "stale_inventory",
    "stale_candidate",
  ] as const);
  const runtime = tally(rows, (row) => row.runtimeStatus, [
    "not_implemented",
    "conformance_passed",
  ] as const);
  const shape = tally(rows, (row) => row.shape, ["executable_shape", "needs_driver"] as const);
  const mismatched = rows.length - lineage.matched;

  const conflictTotal = conflicting.reduce(
    (total, candidate) => total + candidate.conflicts.length,
    0,
  );
  const blockersByCode: Record<LegacyScorecardBlockerCode, () => LegacyScorecardBlocker[]> = {
    safety_refusal: () =>
      blocker(
        "safety_refusal",
        safetyRefusals,
        `${safetyRefusals} collector diagnostic(s) are safety refusals; the refused material contributed no evidence.`,
      ),
    coverage_requirement_unsatisfied: () =>
      blocker(
        "coverage_requirement_unsatisfied",
        unsatisfied.length,
        `Unsatisfied coverage requirement(s): ${unsatisfied.join(", ")}.`,
      ),
    candidate_conflict: () =>
      blocker(
        "candidate_conflict",
        conflicting.length,
        `${conflicting.length} candidate(s) carry ${conflictTotal} unresolved claim conflict(s).`,
      ),
    business_semantics_unknown: () =>
      blocker(
        "business_semantics_unknown",
        semantics.unknown,
        `${semantics.unknown} candidate(s) have no evidenced business operation or effect.`,
      ),
    business_semantics_conflicting: () =>
      blocker(
        "business_semantics_conflicting",
        semantics.conflicting,
        `${semantics.conflicting} candidate(s) carry conflicting business assertions.`,
      ),
    binding_lineage_mismatch: () =>
      blocker(
        "binding_lineage_mismatch",
        mismatched,
        `${mismatched} binding(s) name a candidate, inventory, or candidate hash that is not in this inventory.`,
      ),
    binding_needs_driver: () =>
      needsDriverFamilies.flatMap((family) =>
        blocker(
          "binding_needs_driver",
          family.count,
          `${family.count} binding(s) need the '${family.key}' adapter family; no conformance runner exists for it.`,
          family.key,
        ),
      ),
    binding_not_implemented: () =>
      blocker(
        "binding_not_implemented",
        runtime.not_implemented,
        `${runtime.not_implemented} binding(s) have runtime status not_implemented; no conformance report has moved them.`,
      ),
  };
  const blockers = BLOCKER_ORDER.flatMap((code) => blockersByCode[code]());

  const core: z.infer<typeof ScorecardCore> = {
    schemaVersion: 1,
    estate: {
      id: snapshot.estate.id,
      ...(snapshot.estate.name ? { name: snapshot.estate.name } : {}),
      inventoryId: snapshot.inventoryId,
      inventoryContentHash: snapshot.contentHash,
      coordinates: new Set(
        candidates.map(
          (candidate) =>
            `${candidate.coordinate.environment}\u0000${candidate.coordinate.application}`,
        ),
      ).size,
      artifacts: snapshot.artifacts.length,
      evidence: snapshot.evidence.length,
      observations: snapshot.observations.length,
      diagnostics,
      safetyRefusals,
    },
    capabilities: {
      total: candidates.length,
      byInvocationKind: histogram(candidates.map((candidate) => candidate.invocation.kind)),
      byProtocol: histogram(
        candidates.map((candidate) => legacyInvocationProtocol(candidate.invocation)),
      ),
      byDisposition: tally(candidates, (candidate) => candidate.disposition, [
        "triage",
        "review_required",
      ] as const),
      withConflicts: {
        candidates: conflicting.length,
        conflicts: conflictTotal,
        byDimension: histogram(
          conflicting.flatMap((candidate) => [
            ...new Set(candidate.conflicts.map((conflict) => conflict.dimension)),
          ]),
          "count",
        ),
      },
      businessSemantics: semantics,
      unknownDimensions: unknownDimensions(candidates),
    },
    coverage: {
      reportId: coverage.reportId,
      contentHash: coverage.contentHash,
      ...(coverage.planId ? { planId: coverage.planId } : {}),
      outcome: coverage.outcome,
      semanticComplete: coverage.semanticComplete,
      requirements: tally(coverage.requirements, (requirement) => requirement.status, [
        "satisfied",
        "partial",
        "missing",
        "not_applicable",
      ] as const),
      unsatisfied,
    },
    review: {
      bindingsSupplied: rows.length,
      candidatesReviewed: reviewedCandidateIds.size,
      candidatesUnreviewed: candidates.length - reviewedCandidateIds.size,
      byLineage: lineage,
      byRuntimeStatus: runtime,
      byShape: shape,
      needsDriverFamilies,
      bindings: rows,
    },
    blockers,
  };
  return LegacyModernizationScorecard.parse({ ...core, ...scorecardAddress(core) });
}

function bindingRow(
  binding: LegacyCapabilityBindingType,
  inventoryId: string,
  candidateById: ReadonlyMap<string, LegacyCapabilityCandidate>,
): LegacyScorecardBinding {
  const candidate = candidateById.get(binding.candidateId);
  const lineage: LegacyScorecardBinding["lineage"] = !candidate
    ? "unmatched_candidate"
    : binding.inventoryId !== inventoryId
      ? "stale_inventory"
      : binding.candidateHash !== `sha256:${hashCanonical(candidate)}`
        ? "stale_candidate"
        : "matched";
  const shape = classifyLegacyTransportShape(binding.transport);
  return LegacyScorecardBinding.parse({
    bindingId: binding.bindingId,
    candidateId: binding.candidateId,
    operationName: binding.operation.name,
    transport: transportLabel(binding),
    runtimeStatus: binding.runtime.status,
    shape,
    ...(shape === "needs_driver" ? { family: legacyAdapterFamily(binding.transport) } : {}),
    lineage,
  });
}

function unknownDimensions(
  candidates: readonly LegacyCapabilityCandidate[],
): { key: LegacyClaimDimension; count: number }[] {
  const absent = new Map<LegacyClaimDimension, number>(
    LegacyClaimDimension.options.map((dimension) => [dimension, 0]),
  );
  for (const candidate of candidates) {
    const present = new Set(candidate.claims.map((claim) => claim.dimension));
    for (const dimension of LegacyClaimDimension.options) {
      if (!present.has(dimension)) absent.set(dimension, (absent.get(dimension) ?? 0) + 1);
    }
  }
  return [...absent.entries()]
    .map(([key, total]) => ({ key, count: total }))
    .sort((left, right) =>
      left.count !== right.count ? right.count - left.count : left.key.localeCompare(right.key),
    );
}

function tally<T, K extends string>(
  items: readonly T[],
  pick: (item: T) => K,
  keys: readonly K[],
): Record<K, number> {
  const result = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  for (const item of items) result[pick(item)] += 1;
  return result;
}

export { renderLegacyModernizationScorecard } from "./scorecard-render.js";
