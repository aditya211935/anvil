import type { MainframeDataset, MainframeObservation } from "./collectors/mainframe/index.js";
import type { LegacyCollectorDiagnostic } from "./core/index.js";
import {
  bounded,
  claim,
  emitObservation,
  evidenceFor,
  type NormalizationState,
  stringArray,
  technicalClaims,
} from "./normalization.js";

const MAINFRAME_PLATFORM = "zos-jcl";

/**
 * Project one JCL job or procedure into a `batch_job` observation. Every claim
 * is `declared`: JCL states which programs run, in which order, and which
 * datasets are opened with which disposition. It does not state whether a
 * step is idempotent or restartable, so no such claim is ever emitted.
 */
export function normalizeMainframeObservation(
  state: NormalizationState,
  observation: MainframeObservation,
): void {
  const evidenceIds = evidenceFor(
    state,
    "mainframe",
    observation.evidence.map((coordinate) => ({
      path: coordinate.origin,
      ...(coordinate.pointer ? { pointer: coordinate.pointer } : {}),
      ...(coordinate.span ? { span: coordinate.span } : {}),
    })),
    "declared",
  );
  if (evidenceIds.length === 0) return;
  const claims = technicalClaims(observation.name, evidenceIds, "declared");
  const steps = observation.steps
    .slice(0, 64)
    .map(
      (step) =>
        `${String(step.ordinal).padStart(3, "0")}:${step.name}:${
          step.program ? `PGM=${step.program}` : step.procedure ? `PROC=${step.procedure}` : "EXEC"
        }`,
    );
  if (steps.length > 0) claims.push(claim("binding_target", steps, evidenceIds, "declared"));
  claims.push(claim("interaction_pattern", "batch", evidenceIds, "declared"));

  const datasets = [
    ...observation.libraryDatasets,
    ...observation.steps.flatMap((step) => step.datasets),
  ];
  const inputs = schemaRefs(datasets.filter((dataset) => dataset.direction === "input"));
  const copybooks = datasets.flatMap((dataset) =>
    dataset.copybookPath ? [`copybook:${dataset.copybookPath}`] : [],
  );
  const inputRefs = stringArray([...inputs, ...copybooks]).slice(0, 64);
  if (inputRefs.length > 0) claims.push(claim("input_schema", inputRefs, evidenceIds, "declared"));
  const outputs = schemaRefs(datasets.filter((dataset) => dataset.direction === "output"));
  if (outputs.length > 0) {
    claims.push(claim("output_schema", outputs.slice(0, 64), evidenceIds, "declared"));
  }

  const errorSemantics = stringArray([
    ...observation.steps.flatMap((step) => (step.cond ? [`${step.name} COND=${step.cond}`] : [])),
    ...observation.conditions.map((condition) => `IF ${condition}`),
  ]).slice(0, 64);
  if (errorSemantics.length > 0) {
    claims.push(claim("error_semantics", errorSemantics, evidenceIds, "declared"));
  }

  emitObservation(state, {
    collectorId: "mainframe",
    platform: MAINFRAME_PLATFORM,
    ...(observation.kind === "procedure" ? { module: "proclib" } : {}),
    component: observation.name,
    invocation: {
      kind: "batch_job",
      schedulerRef: bounded(observation.schedulerRef, 512),
      job: bounded(observation.name, 512),
    },
    claims,
    evidenceIds,
  });
}

export function addMainframeNoInvocationDiagnostic(
  state: NormalizationState,
  rawObservations: number,
  normalizedObservations: number,
  collectorDiagnostics: readonly { level: "info" | "warning" | "error" }[],
): void {
  if (
    rawObservations === 0 ||
    normalizedObservations > 0 ||
    collectorDiagnostics.some((diagnostic) => diagnostic.level !== "info")
  ) {
    return;
  }
  const diagnostic: LegacyCollectorDiagnostic = {
    level: "warning",
    code: "legacy/mainframe/no_invocation_candidate",
    message:
      "JCL members were retained as evidence, but none proved a batch job or procedure invocation.",
    remediation: "Supply the JOB or PROC member that declares the steps, not only its includes.",
    collectorId: "mainframe",
  };
  state.diagnostics.push(diagnostic);
}

/** Durable dataset names only: `&&TEMP` passes, SYSOUT, DUMMY, and in-stream DDs are not interfaces. */
function schemaRefs(datasets: readonly MainframeDataset[]): string[] {
  return stringArray(
    datasets.flatMap((dataset) =>
      dataset.dsn && !dataset.dsn.startsWith("&&") ? [`dsn:${dataset.dsn}`] : [],
    ),
  );
}
