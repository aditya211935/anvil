import { createHash } from "node:crypto";
import type {
  DatabaseArtifactEvidence,
  DatabaseArtifactInput,
  DatabaseArtifactRole,
  DatabaseCollectorResult,
  DatabaseDiagnostic,
  DatabaseEvidenceCoordinate,
  DatabaseObservation,
  DatabaseTransactionFact,
} from "./model.js";
import { type PlsqlSubprogram, scanPlsqlUnit } from "./plsql.js";
import {
  acceptDatabaseArtifacts,
  containsSecretLikeSql,
  deduplicateDiagnostics,
  refusal,
  scrubSql,
} from "./safety.js";
import { canonicalParameters, type SqlUnit, splitUnits } from "./scan.js";
import { scanTsqlUnit, type TsqlProcedure } from "./tsql.js";

/**
 * Read stored-procedure DDL exports as inert text and describe the declared
 * subprograms. The scanner is lexical: it strips comments and string literals,
 * segments top-level units, and reads headers and literal body keywords. It
 * never evaluates SQL, resolves types, or guesses result-set shapes.
 */
export function collectDatabaseLegacy(
  inputs: readonly DatabaseArtifactInput[],
): DatabaseCollectorResult {
  const accepted = acceptDatabaseArtifacts(inputs);
  const diagnostics = [...accepted.diagnostics];
  const evidence: DatabaseArtifactEvidence[] = [];
  const plsql: PlsqlSubprogram[] = [];
  const tsql: TsqlProcedure[] = [];

  for (const artifact of accepted.artifacts) {
    if (containsSecretLikeSql(artifact.text)) {
      diagnostics.push(refusal("database/secret_like_value", artifact.path));
      continue;
    }
    const scrubbed = scrubSql(artifact.text);
    let role: DatabaseArtifactRole = "sql_script";
    let sawProgramUnit = false;
    let selectsResultSet = false;
    for (const unit of splitUnits(scrubbed)) {
      const dialect = detectDialect(unit);
      if (dialect === "plsql") {
        sawProgramUnit = true;
        const subprograms = scanPlsqlUnit(unit, artifact.path);
        plsql.push(...subprograms);
        role = strongerRole(
          role,
          /\bPACKAGE\s+BODY\b/i.test(unit.text)
            ? "package_body"
            : /\bPACKAGE\b/i.test(unit.text)
              ? "package_specification"
              : "standalone_ddl",
        );
      } else if (dialect === "tsql") {
        sawProgramUnit = true;
        if (/^\s*CREATE\s+(?:OR\s+ALTER\s+)?FUNCTION\b/i.test(unit.text)) {
          diagnostics.push({
            level: "info",
            code: "database/tsql_function_unsupported",
            message: `Recorded a T-SQL function in '${artifact.path}' as evidence only; scalar and table-valued function contracts are not projected.`,
            coordinate: { origin: artifact.path },
          });
          continue;
        }
        const procedures = scanTsqlUnit(unit, artifact.path);
        tsql.push(...procedures);
        selectsResultSet ||= procedures.some((procedure) => procedure.selectsResultSet);
        role = strongerRole(role, "standalone_ddl");
      }
    }
    if (!sawProgramUnit) {
      diagnostics.push({
        level: "info",
        code: "database/no_procedure_ddl",
        message: `Recorded '${artifact.path}' as evidence, but it declares no stored procedure, function, or package.`,
        coordinate: { origin: artifact.path },
      });
    }
    if (selectsResultSet) {
      diagnostics.push({
        level: "info",
        code: "database/result_set_unproven",
        message: `T-SQL procedures in '${artifact.path}' select rows; DDL cannot prove a result-set shape, so no output schema is claimed for them.`,
        coordinate: { origin: artifact.path },
      });
    }
    evidence.push({ ...artifact.evidence, role });
  }

  const observations = [
    ...reconcilePlsql(plsql, diagnostics),
    ...reconcileTsql(tsql, diagnostics),
  ].sort((a, b) => `${a.coordinate}:${a.id}`.localeCompare(`${b.coordinate}:${b.id}`));

  return {
    collector: { kind: "database", schemaVersion: 1 },
    evidence,
    observations,
    diagnostics: deduplicateDiagnostics(diagnostics).sort(diagnosticOrder),
  };
}

const PACKAGE_UNIT =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?PACKAGE\b(?!\s*\[)/i;
const PROGRAM_UNIT =
  /^\s*CREATE\s+(?:OR\s+(REPLACE|ALTER)\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROC|PROCEDURE|FUNCTION)\s+([^\n]*)/i;

type Dialect = "plsql" | "tsql";

/**
 * Decide which dialect's grammar a unit follows. `PACKAGE`, `OR REPLACE`, `IS`,
 * and `IN OUT` mark PL/SQL; `OR ALTER`, `PROC`, and `@` parameters mark T-SQL.
 * A header both grammars accept is settled by body markers, and a unit that
 * neither grammar claims is ignored rather than guessed.
 */
function detectDialect(unit: SqlUnit): Dialect | undefined {
  if (PACKAGE_UNIT.test(unit.text)) return "plsql";
  const header = PROGRAM_UNIT.exec(unit.text);
  if (!header) return undefined;
  if (/^REPLACE$/i.test(header[1] ?? "")) return "plsql";
  if (/^ALTER$/i.test(header[1] ?? "")) return "tsql";
  if (/^PROC$/i.test(header[2] ?? "")) return "tsql";
  const rest = unit.text.slice(header.index + header[0].length - (header[3]?.length ?? 0));
  const afterName = rest.replace(
    /^\s*(?:"[^"\n]+"|\[[^\]\n]+\]|[A-Za-z_][\w$#]*)(?:\s*\.\s*(?:"[^"\n]+"|\[[^\]\n]+\]|[A-Za-z_][\w$#]*)){0,2}(?:\s*;\s*\d+)?/,
    "",
  );
  if (/^\s*\(?\s*@/.test(afterName)) return "tsql";
  if (/^FUNCTION$/i.test(header[2] ?? "")) return "plsql";
  if (/^\s*(?:\([\s\S]*?\)\s*)?IS\b/i.test(afterName)) return "plsql";
  if (/\bIN\s+OUT\b|:=|%(?:ROW)?TYPE\b|\bEXCEPTION\s+WHEN\b|\bDBMS_\w+/i.test(afterName)) {
    return "plsql";
  }
  if (
    /@[\w$@#]+|\bSET\s+NOCOUNT\b|\bBEGIN\s+TRAN|\[[^\]\n]+\]|\bRAISERROR\b|\bTHROW\b/i.test(
      afterName,
    )
  ) {
    return "tsql";
  }
  return "plsql";
}

const ROLE_RANK: Record<DatabaseArtifactRole, number> = {
  sql_script: 0,
  standalone_ddl: 1,
  package_body: 2,
  package_specification: 3,
};

function strongerRole(current: DatabaseArtifactRole, next: DatabaseArtifactRole) {
  return ROLE_RANK[next] > ROLE_RANK[current] ? next : current;
}

interface SignatureGroup {
  key: string;
  members: PlsqlSubprogram[];
}

function reconcilePlsql(
  subprograms: readonly PlsqlSubprogram[],
  diagnostics: DatabaseDiagnostic[],
): DatabaseObservation[] {
  const byName = new Map<string, PlsqlSubprogram[]>();
  for (const subprogram of subprograms) {
    const key = `plsql:${subprogram.schema ?? ""}:${subprogram.package ?? ""}:${subprogram.name}`;
    byName.set(key, [...(byName.get(key) ?? []), subprogram]);
  }
  const specifiedPackages = new Set(
    subprograms
      .filter((item) => item.source === "package_specification")
      .map((item) => `${item.schema ?? ""}:${item.package ?? ""}`),
  );
  const observations: DatabaseObservation[] = [];
  const bodyOnlyPackages = new Set<string>();
  for (const [, members] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const specifications = members.filter((item) => item.source === "package_specification");
    const standalone = members.filter((item) => item.source === "standalone");
    const bodies = members.filter((item) => item.source === "package_body");
    const signatureSources =
      specifications.length > 0 ? specifications : standalone.length > 0 ? standalone : bodies;
    if (signatureSources === bodies && bodies.length > 0) {
      const first = bodies[0];
      // A body subprogram absent from an available specification is private.
      if (first && specifiedPackages.has(`${first.schema ?? ""}:${first.package ?? ""}`)) continue;
      if (first) {
        bodyOnlyPackages.add(
          `${first.evidence.origin}\u0000${[first.schema, first.package].filter(Boolean).join(".")}`,
        );
      }
    }
    const groups = groupBySignature(signatureSources);
    if (groups.length > 1) {
      const first = signatureSources[0];
      if (first) {
        diagnostics.push({
          level: "info",
          code: "database/multiple_signatures",
          message: `Retained ${groups.length} distinct signatures for '${qualifiedName(first)}'; overloads or divergent exports stay a reviewable conflict rather than a chosen signature.`,
          coordinate: first.evidence,
        });
      }
    }
    for (const group of groups) {
      const primary = group.members[0];
      if (!primary) continue;
      const sameArity = bodies.filter(
        (body) => body.parameters.length === primary.parameters.length,
      );
      const attachedBodies =
        signatureSources === bodies ? [] : sameArity.length > 0 ? sameArity : bodies;
      const facts = [...group.members, ...attachedBodies];
      const coordinate = `plsql:${primary.schema ?? "unknown-schema"}:${primary.package ?? "-"}:${primary.name}`;
      const evidence = uniqueEvidence(facts.map((item) => item.evidence));
      observations.push(
        withId({
          id: "",
          kind: primary.kind,
          coordinate,
          dialect: "plsql",
          ...(primary.schema ? { schema: primary.schema } : {}),
          ...(primary.package ? { package: primary.package } : {}),
          name: primary.name,
          parameters: primary.parameters,
          ...(primary.returnType ? { returnType: primary.returnType } : {}),
          signatureSource: primary.source,
          transaction: uniqueFacts(facts.flatMap((item) => item.transaction)),
          errorFacts: [...new Set(facts.flatMap((item) => item.errorFacts))].sort(),
          evidence,
          confidence: "declared",
        }),
      );
    }
  }
  for (const entry of [...bodyOnlyPackages].sort()) {
    const [origin, packageName] = entry.split("\u0000");
    diagnostics.push({
      level: "warning",
      code: "database/package_body_without_specification",
      message: `Package body '${packageName}' in '${origin}' has no specification in this export; signatures were read from the body and public visibility is unproven.`,
      coordinate: { origin: origin ?? "" },
    });
  }
  return observations;
}

function reconcileTsql(
  procedures: readonly TsqlProcedure[],
  diagnostics: DatabaseDiagnostic[],
): DatabaseObservation[] {
  const byName = new Map<string, TsqlProcedure[]>();
  for (const procedure of procedures) {
    const key = `tsql:${procedure.schema ?? ""}:${procedure.name.toUpperCase()}`;
    byName.set(key, [...(byName.get(key) ?? []), procedure]);
  }
  const observations: DatabaseObservation[] = [];
  for (const [, members] of [...byName.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bySignature = new Map<string, TsqlProcedure[]>();
    for (const member of members) {
      const key = canonicalParameters(member.parameters);
      bySignature.set(key, [...(bySignature.get(key) ?? []), member]);
    }
    const first = members[0];
    if (bySignature.size > 1 && first) {
      diagnostics.push({
        level: "info",
        code: "database/multiple_signatures",
        message: `Retained ${bySignature.size} distinct signatures for '${[first.schema, first.name].filter(Boolean).join(".")}'; divergent exports stay a reviewable conflict rather than a chosen signature.`,
        coordinate: first.evidence,
      });
    }
    for (const [, group] of [...bySignature.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const primary = group[0];
      if (!primary) continue;
      observations.push(
        withId({
          id: "",
          kind: "stored_procedure",
          coordinate: `tsql:${primary.schema ?? "unknown-schema"}:-:${primary.name.toUpperCase()}`,
          dialect: "tsql",
          ...(primary.schema ? { schema: primary.schema } : {}),
          name: primary.name,
          parameters: primary.parameters,
          signatureSource: "standalone",
          transaction: uniqueFacts(group.flatMap((item) => item.transaction)),
          errorFacts: [...new Set(group.flatMap((item) => item.errorFacts))].sort(),
          evidence: uniqueEvidence(group.map((item) => item.evidence)),
          confidence: "declared",
        }),
      );
    }
  }
  return observations;
}

function groupBySignature(subprograms: readonly PlsqlSubprogram[]): SignatureGroup[] {
  const groups = new Map<string, PlsqlSubprogram[]>();
  for (const subprogram of subprograms) {
    const key = `${subprogram.kind}:${canonicalParameters(subprogram.parameters)}:${subprogram.returnType ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), subprogram]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => ({ key, members }));
}

function qualifiedName(subprogram: PlsqlSubprogram): string {
  return [subprogram.schema, subprogram.package, subprogram.name].filter(Boolean).join(".");
}

const FACT_ORDER: DatabaseTransactionFact[] = [
  "autonomous",
  "begins_transaction",
  "commits_internally",
  "rolls_back_internally",
];

function uniqueFacts(facts: readonly DatabaseTransactionFact[]): DatabaseTransactionFact[] {
  const present = new Set(facts);
  return FACT_ORDER.filter((fact) => present.has(fact));
}

function uniqueEvidence(
  evidence: readonly DatabaseEvidenceCoordinate[],
): DatabaseEvidenceCoordinate[] {
  return [
    ...new Map(
      evidence.map((item) => [
        `${item.origin}:${item.pointer ?? ""}:${item.span?.start ?? ""}:${item.span?.end ?? ""}`,
        item,
      ]),
    ).values(),
  ].sort((a, b) =>
    `${a.origin}:${a.pointer ?? ""}:${a.span?.start ?? 0}`.localeCompare(
      `${b.origin}:${b.pointer ?? ""}:${b.span?.start ?? 0}`,
    ),
  );
}

function withId(observation: DatabaseObservation): DatabaseObservation {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        coordinate: observation.coordinate,
        kind: observation.kind,
        parameters: observation.parameters,
        returnType: observation.returnType ?? null,
        source: observation.signatureSource,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return { ...observation, id: `legacy_${hash}` };
}

function diagnosticOrder(a: DatabaseDiagnostic, b: DatabaseDiagnostic): number {
  return `${a.coordinate?.origin ?? ""}:${a.code}:${a.coordinate?.pointer ?? ""}`.localeCompare(
    `${b.coordinate?.origin ?? ""}:${b.code}:${b.coordinate?.pointer ?? ""}`,
  );
}
