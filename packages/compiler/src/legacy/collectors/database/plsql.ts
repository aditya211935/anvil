import type {
  DatabaseEvidenceCoordinate,
  DatabaseParameter,
  DatabaseSignatureSource,
  DatabaseTransactionFact,
} from "./model.js";
import {
  matchParen,
  parsePlsqlParameter,
  QUALIFIED_NAME,
  type SqlUnit,
  splitQualifiedName,
  splitTopLevel,
} from "./scan.js";

/** One subprogram declaration or definition read from a PL/SQL unit. */
export interface PlsqlSubprogram {
  kind: "stored_procedure" | "stored_function";
  schema?: string;
  package?: string;
  name: string;
  parameters: DatabaseParameter[];
  returnType?: string;
  source: DatabaseSignatureSource;
  /** Body facts; empty for a specification. */
  transaction: DatabaseTransactionFact[];
  errorFacts: string[];
  evidence: DatabaseEvidenceCoordinate;
}

const PACKAGE_HEADER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?PACKAGE\s+(BODY\s+)?(${QUALIFIED_NAME})`,
  "i",
);
const STANDALONE_HEADER = new RegExp(
  String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(PROCEDURE|FUNCTION)\s+(${QUALIFIED_NAME})`,
  "i",
);
const SUBPROGRAM_HEADER = /\b(PROCEDURE|FUNCTION)\s+("[^"\n]+"|[A-Za-z_][\w$#]*)/gi;
const RETURN_TYPE = /^\s*RETURN\s+([\w$#".%]+(?:\s*\.\s*[\w$#"%]+)*)/i;

export function scanPlsqlUnit(unit: SqlUnit, origin: string): PlsqlSubprogram[] {
  const packageHeader = PACKAGE_HEADER.exec(unit.text);
  if (packageHeader) {
    const isBody = Boolean(packageHeader[1]);
    const nameParts = splitQualifiedName(packageHeader[2] ?? "", "plsql");
    const packageName = nameParts[nameParts.length - 1];
    const schema = nameParts.length > 1 ? nameParts[nameParts.length - 2] : undefined;
    if (!packageName) return [];
    const bodyStart = packageHeader.index + packageHeader[0].length;
    const bodyStarts = bodyStartsOf(unit.text, bodyStart);
    return bodyStarts.flatMap((position, index) => {
      const segmentEnd = bodyStarts[index + 1] ?? unit.text.length;
      const parsed = parseSubprogramHeader(unit.text, position);
      if (!parsed) return [];
      const segment = unit.text.slice(position, segmentEnd);
      return [
        {
          kind: parsed.kind,
          ...(schema ? { schema } : {}),
          package: packageName,
          name: parsed.name,
          parameters: parsed.parameters,
          ...(parsed.returnType ? { returnType: parsed.returnType } : {}),
          source: isBody ? "package_body" : "package_specification",
          transaction: isBody ? transactionFacts(segment) : [],
          errorFacts: isBody ? errorFacts(segment) : [],
          evidence: {
            origin,
            pointer: `${isBody ? "package_body" : "package_specification"}:${[schema, packageName]
              .filter(Boolean)
              .join(".")}/${parsed.name}`,
            span: { start: unit.start + position, end: unit.start + parsed.headerEnd },
          },
        },
      ];
    });
  }

  const standalone = STANDALONE_HEADER.exec(unit.text);
  if (!standalone) return [];
  const nameParts = splitQualifiedName(standalone[2] ?? "", "plsql");
  const name = nameParts[nameParts.length - 1];
  if (!name) return [];
  const schema = nameParts.length > 1 ? nameParts[nameParts.length - 2] : undefined;
  const keywordIndex = standalone.index + standalone[0].search(/\b(?:PROCEDURE|FUNCTION)\b/i);
  const parsed = parseSubprogramHeader(unit.text, keywordIndex);
  if (!parsed) return [];
  return [
    {
      kind: parsed.kind,
      ...(schema ? { schema } : {}),
      name,
      parameters: parsed.parameters,
      ...(parsed.returnType ? { returnType: parsed.returnType } : {}),
      source: "standalone",
      transaction: transactionFacts(unit.text),
      errorFacts: errorFacts(unit.text),
      evidence: {
        origin,
        pointer: `standalone:${[schema, name].filter(Boolean).join(".")}`,
        span: { start: unit.start + keywordIndex, end: unit.start + parsed.headerEnd },
      },
    },
  ];
}

function bodyStartsOf(text: string, from: number): number[] {
  const starts: number[] = [];
  const pattern = new RegExp(SUBPROGRAM_HEADER.source, "gi");
  for (const match of text.slice(from).matchAll(pattern)) {
    starts.push(from + (match.index ?? 0));
  }
  return starts;
}

function parseSubprogramHeader(
  text: string,
  position: number,
):
  | {
      kind: PlsqlSubprogram["kind"];
      name: string;
      parameters: DatabaseParameter[];
      returnType?: string;
      headerEnd: number;
    }
  | undefined {
  const header = new RegExp(String.raw`^(PROCEDURE|FUNCTION)\s+(${QUALIFIED_NAME})\s*`, "i").exec(
    text.slice(position),
  );
  if (!header) return undefined;
  const kind = /^FUNCTION$/i.test(header[1] ?? "") ? "stored_function" : "stored_procedure";
  const nameParts = splitQualifiedName(header[2] ?? "", "plsql");
  const name = nameParts[nameParts.length - 1];
  if (!name) return undefined;
  let cursor = position + header[0].length;
  let parameters: DatabaseParameter[] = [];
  if (text[cursor] === "(") {
    const close = matchParen(text, cursor);
    if (close < 0) return undefined;
    parameters = splitTopLevel(text.slice(cursor + 1, close)).flatMap((raw) => {
      const parsed = parsePlsqlParameter(raw);
      return parsed ? [parsed] : [];
    });
    cursor = close + 1;
  }
  let returnType: string | undefined;
  if (kind === "stored_function") {
    const returned = RETURN_TYPE.exec(text.slice(cursor));
    if (returned) {
      returnType = (returned[1] ?? "").replace(/\s+/g, "").toUpperCase();
      cursor += returned[0].length;
    }
  }
  return { kind, name, parameters, ...(returnType ? { returnType } : {}), headerEnd: cursor };
}

function transactionFacts(segment: string): DatabaseTransactionFact[] {
  const facts: DatabaseTransactionFact[] = [];
  if (/\bPRAGMA\s+AUTONOMOUS_TRANSACTION\b/i.test(segment)) facts.push("autonomous");
  if (/\bCOMMIT\b/i.test(segment)) facts.push("commits_internally");
  if (/\bROLLBACK\b/i.test(segment)) facts.push("rolls_back_internally");
  return facts;
}

function errorFacts(segment: string): string[] {
  const codes = new Set<string>();
  for (const match of segment.matchAll(/\bRAISE_APPLICATION_ERROR\s*\(\s*(-?\d+)/gi)) {
    codes.add(`raise_application_error:${match[1]}`);
  }
  return [...codes].sort();
}
