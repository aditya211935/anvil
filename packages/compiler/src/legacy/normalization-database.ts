import type { DatabaseObservation, DatabaseParameter } from "./collectors/database/index.js";
import { canonicalParameters } from "./collectors/database/index.js";
import type { LegacyClaim } from "./core/index.js";
import {
  bounded,
  claim,
  emitObservation,
  evidenceFor,
  type NormalizationState,
} from "./normalization.js";

/**
 * Project one declared stored procedure or function into the shared inventory
 * vocabulary. Every claim is `declared`: the DDL text literally states it.
 * Idempotency is never asserted, and an output schema is claimed only for OUT
 * parameters or a declared RETURN type, never for result sets.
 */
export function normalizeDatabaseObservation(
  state: NormalizationState,
  observation: DatabaseObservation,
): void {
  const evidenceIds = evidenceFor(
    state,
    "database",
    observation.evidence.map((coordinate) => ({
      path: coordinate.origin,
      ...(coordinate.pointer ? { pointer: coordinate.pointer } : {}),
      ...(coordinate.span ? { span: coordinate.span } : {}),
    })),
    "declared",
  );
  if (evidenceIds.length === 0) return;

  const procedure = [observation.package, observation.name].filter(Boolean).join(".");
  const bindingTarget = [observation.schema, observation.package, observation.name]
    .filter(Boolean)
    .join(".");
  const outputs = observation.parameters.filter((parameter) => parameter.mode !== "in");
  const claims: LegacyClaim[] = [
    claim("technical_name", bounded(procedure, 2048), evidenceIds, "declared"),
    claim("binding_target", bounded(bindingTarget, 2048), evidenceIds, "declared"),
    claim(
      "input_schema",
      bounded(canonicalParameters(observation.parameters), 2048),
      evidenceIds,
      "declared",
    ),
  ];
  const output = outputSchema(outputs, observation.returnType);
  if (output) claims.push(claim("output_schema", bounded(output, 2048), evidenceIds, "declared"));
  if (observation.kind === "stored_function" || outputs.length > 0) {
    claims.push(claim("interaction_pattern", "request_reply", evidenceIds, "declared"));
  }
  if (observation.transaction.length > 0) {
    claims.push(
      claim("transaction_boundary", [...observation.transaction], evidenceIds, "declared"),
    );
  }
  if (observation.errorFacts.length > 0) {
    claims.push(
      claim(
        "error_semantics",
        observation.errorFacts.slice(0, 64).map((fact) => bounded(fact, 512)),
        evidenceIds,
        "declared",
      ),
    );
  }

  emitObservation(state, {
    collectorId: "database",
    platform: observation.dialect,
    module: coordinateSegment(
      [observation.schema, observation.package].filter(Boolean).join(".") ||
        state.coordinate.application,
    ),
    component: coordinateSegment(observation.name),
    invocation: {
      kind: "stored_procedure",
      databaseRef: bounded(observation.schema ?? "unknown-schema", 512),
      procedure: bounded(procedure, 512),
    },
    claims,
    evidenceIds,
  });
}

function outputSchema(
  outputs: readonly DatabaseParameter[],
  returnType: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (outputs.length > 0) parts.push(canonicalParameters(outputs));
  if (returnType) parts.push(`RETURN ${returnType}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Lower-case the declared spelling for the coordinate; claims keep the original. */
function coordinateSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._:@/-]+/g, "-");
}
