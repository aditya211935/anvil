import type {
  DatabaseEvidenceCoordinate,
  DatabaseParameter,
  DatabaseTransactionFact,
} from "./model.js";
import {
  matchParen,
  parseTsqlParameter,
  QUALIFIED_NAME,
  type SqlUnit,
  splitQualifiedName,
  splitTopLevel,
} from "./scan.js";

export interface TsqlProcedure {
  schema?: string;
  name: string;
  parameters: DatabaseParameter[];
  transaction: DatabaseTransactionFact[];
  errorFacts: string[];
  /** The body contains a SELECT whose result-set shape DDL cannot prove. */
  selectsResultSet: boolean;
  evidence: DatabaseEvidenceCoordinate;
}

const PROCEDURE_HEADER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+(${QUALIFIED_NAME})(?:\s*;\s*\d+)?`,
  "i",
);

export function scanTsqlUnit(unit: SqlUnit, origin: string): TsqlProcedure[] {
  const header = PROCEDURE_HEADER.exec(unit.text);
  if (!header) return [];
  const nameParts = splitQualifiedName(header[1] ?? "", "tsql");
  const name = nameParts[nameParts.length - 1];
  if (!name) return [];
  const schema = nameParts.length > 1 ? nameParts[nameParts.length - 2] : undefined;
  const headerEnd = header[0].length;
  const bodyAs = findBodyAs(unit.text, headerEnd);
  const parameterText = unit.text.slice(headerEnd, bodyAs < 0 ? unit.text.length : bodyAs);
  const parameters = parseParameters(parameterText);
  const body = bodyAs < 0 ? "" : unit.text.slice(bodyAs);
  return [
    {
      ...(schema ? { schema } : {}),
      name,
      parameters,
      transaction: transactionFacts(body),
      errorFacts: errorFacts(body),
      selectsResultSet: /\bSELECT\b/i.test(body),
      evidence: {
        origin,
        pointer: `procedure:${[schema, name].filter(Boolean).join(".")}`,
        span: { start: unit.start, end: unit.start + (bodyAs < 0 ? headerEnd : bodyAs) },
      },
    },
  ];
}

/**
 * Locate the `AS` that introduces the procedure body: the first top-level `AS`
 * that is neither a parameter's `@name AS type` nor part of `EXECUTE AS`.
 */
function findBodyAs(text: string, from: number): number {
  const pattern = /\bAS\b/gi;
  for (const match of text.slice(from).matchAll(pattern)) {
    const index = from + (match.index ?? 0);
    if (parenDepth(text, from, index) !== 0) continue;
    const before = text.slice(from, index).trimEnd();
    if (/@[\w$@#]+$/.test(before)) continue;
    if (/\bEXEC(?:UTE)?$/i.test(before)) continue;
    return index;
  }
  return -1;
}

function parenDepth(text: string, from: number, to: number): number {
  let depth = 0;
  for (let index = from; index < to; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") depth -= 1;
  }
  return depth;
}

function parseParameters(text: string): DatabaseParameter[] {
  let region = text
    .replace(
      /\bWITH\s+(?:RECOMPILE|ENCRYPTION|NATIVE_COMPILATION|SCHEMABINDING|EXEC(?:UTE)?\s+AS\s+\w+)(?:\s*,\s*(?:RECOMPILE|ENCRYPTION|NATIVE_COMPILATION|SCHEMABINDING|EXEC(?:UTE)?\s+AS\s+\w+))*\s*$/i,
      "",
    )
    .replace(/\bFOR\s+REPLICATION\s*$/i, "")
    .trim();
  if (region.startsWith("(")) {
    const close = matchParen(region, 0);
    if (close > 0) region = region.slice(1, close);
  }
  return splitTopLevel(region).flatMap((raw) => {
    const parsed = parseTsqlParameter(raw);
    return parsed ? [parsed] : [];
  });
}

function transactionFacts(body: string): DatabaseTransactionFact[] {
  const facts: DatabaseTransactionFact[] = [];
  if (/\bBEGIN\s+(?:DISTRIBUTED\s+)?TRAN(?:SACTION)?\b/i.test(body))
    facts.push("begins_transaction");
  if (/\bCOMMIT\b/i.test(body)) facts.push("commits_internally");
  if (/\bROLLBACK\b/i.test(body)) facts.push("rolls_back_internally");
  return facts;
}

function errorFacts(body: string): string[] {
  const facts = new Set<string>();
  for (const match of body.matchAll(/\bTHROW\s+(\d+)\b/gi)) facts.add(`throw:${match[1]}`);
  for (const match of body.matchAll(/\bRAISERROR\s*\(\s*(\d+|[^,)]*)/gi)) {
    const first = (match[1] ?? "").trim();
    facts.add(/^\d+$/.test(first) ? `raiserror:${first}` : "raiserror:message");
  }
  return [...facts].sort();
}
