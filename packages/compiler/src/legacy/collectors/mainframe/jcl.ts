import type { MainframeDiagnostic } from "./model.js";

/** One logical JCL statement after continuation cards are joined. */
export interface JclStatement {
  /** Name field (columns 3-10); empty for unnamed statements. */
  name: string;
  operation: string;
  /** Operand text with continuation cards joined; comments are dropped. */
  operands: string;
  line: number;
  endLine: number;
  /** `DD *` or `DD DATA`: in-stream records followed and were skipped, never read. */
  inStreamData: boolean;
}

export interface JclParseResult {
  statements: JclStatement[];
  diagnostics: MainframeDiagnostic[];
  /** Count of in-stream data records skipped. Content is never retained. */
  inStreamRecords: number;
}

export interface JclOperands {
  positional: string[];
  keywords: Map<string, string>;
}

const JCL_CARD_WIDTH = 72;
const MAX_STATEMENTS = 20_000;
const NAME_PATTERN = /^[A-Z0-9@#$][A-Z0-9@#$]{0,7}$/i;

interface Pending {
  statement: JclStatement;
  /** `literal`: a quoted operand continues at column 16; `operand`: after a trailing comma. */
  mode: "operand" | "literal" | "if";
}

interface InStream {
  delimiter: string;
  /** `DD *` data also ends at the next JCL card; `DD DATA` does not. */
  endsAtJcl: boolean;
}

/**
 * Parse 80-column JCL as inert text. Columns 73-80 are ignored, `//*` cards are
 * comments, and in-stream data after `DD *` / `DD DATA` is skipped up to its
 * delimiter: only the fact that in-stream data exists is recorded.
 */
export function parseJcl(text: string, origin: string): JclParseResult {
  const statements: JclStatement[] = [];
  const diagnostics: MainframeDiagnostic[] = [];
  const flags = { overflow: false, stray: false, unterminated: false, unknownOverflow: false };
  let pending: Pending | undefined;
  let inStream: InStream | undefined;
  let inStreamRecords = 0;

  const finish = (statement: JclStatement): void => {
    pending = undefined;
    if (statements.length >= MAX_STATEMENTS) {
      if (!flags.unknownOverflow) {
        flags.unknownOverflow = true;
        diagnostics.push({
          level: "error",
          code: "mainframe/too_many_statements",
          message: `Stopped reading '${origin}' after ${MAX_STATEMENTS} statements.`,
          coordinate: { origin },
        });
      }
      return;
    }
    statements.push(statement);
    if (statement.operation === "DD") {
      const operands = splitOperands(statement.operands);
      const first = operands.positional[0]?.toUpperCase();
      if (first === "*" || first === "DATA") {
        statement.inStreamData = true;
        const delimiter = unquote(operands.keywords.get("DLM") ?? "/*").slice(0, 2);
        inStream = { delimiter: delimiter || "/*", endsAtJcl: first === "*" };
      }
    }
  };

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const lineNumber = index + 1;
    if (raw.length > 80 && !flags.overflow) {
      flags.overflow = true;
      diagnostics.push({
        level: "warning",
        code: "mainframe/column_overflow",
        message: `'${origin}' has records longer than 80 columns; columns beyond 72 were ignored.`,
        coordinate: { origin, span: { start: lineNumber, end: lineNumber } },
      });
    }
    const card = raw.slice(0, JCL_CARD_WIDTH).replace(/\s+$/, "");

    if (inStream) {
      if (card.startsWith(inStream.delimiter)) {
        inStream = undefined;
        continue;
      }
      if (inStream.endsAtJcl && card.startsWith("//")) {
        inStream = undefined;
      } else {
        inStreamRecords += 1;
        continue;
      }
    }

    if (card.startsWith("//*")) continue;
    if (card.startsWith("/*")) continue;
    if (!card.startsWith("//")) {
      if (card.trim().length === 0) continue;
      if (!flags.stray) {
        flags.stray = true;
        diagnostics.push({
          level: "warning",
          code: "mainframe/unexpected_data_record",
          message: `'${origin}' contains records outside JCL statements and in-stream data; they were ignored.`,
          coordinate: { origin, span: { start: lineNumber, end: lineNumber } },
        });
      }
      continue;
    }

    const rest = card.slice(2);
    if (pending) {
      const current = pending;
      if (rest.startsWith(" ") || rest.length === 0) {
        if (current.mode === "literal") {
          const fragment = card.length > 15 ? card.slice(15) : rest.trimStart();
          current.statement.operands += fragment;
        } else {
          const fragment = current.mode === "if" ? rest.trim() : operandField(rest.trimStart());
          current.statement.operands += current.mode === "if" ? ` ${fragment}` : fragment;
        }
        current.statement.endLine = lineNumber;
        const next = continuationMode(current.statement);
        if (next) current.mode = next;
        else finish(current.statement);
        continue;
      }
      if (!flags.unterminated) {
        flags.unterminated = true;
        diagnostics.push({
          level: "warning",
          code: "mainframe/unterminated_continuation",
          message: `'${origin}' continues a statement that the next card does not complete.`,
          coordinate: { origin, span: { start: lineNumber, end: lineNumber } },
        });
      }
      finish(current.statement);
    }

    if (rest.trim().length === 0) continue; // null statement
    const statement = parseCard(rest, lineNumber);
    if (!statement) continue;
    const mode = continuationMode(statement);
    if (mode) pending = { statement, mode };
    else finish(statement);
  }
  if (pending) finish((pending as Pending).statement);
  return { statements, diagnostics, inStreamRecords };
}

function parseCard(rest: string, line: number): JclStatement | undefined {
  let cursor = 0;
  let name = "";
  if (!rest.startsWith(" ")) {
    const end = rest.search(/\s/);
    name = end === -1 ? rest : rest.slice(0, end);
    cursor = end === -1 ? rest.length : end;
    if (!NAME_PATTERN.test(name)) return undefined;
  }
  const afterName = rest.slice(cursor).trimStart();
  const operationEnd = afterName.search(/\s/);
  const operation = (operationEnd === -1 ? afterName : afterName.slice(0, operationEnd))
    .trim()
    .toUpperCase();
  if (!/^[A-Z]+$/.test(operation)) return undefined;
  const afterOperation = operationEnd === -1 ? "" : afterName.slice(operationEnd).trimStart();
  const operands = operation === "IF" ? afterOperation.trim() : operandField(afterOperation);
  return { name, operation, operands, line, endLine: line, inStreamData: false };
}

function continuationMode(statement: JclStatement): Pending["mode"] | undefined {
  if (statement.operation === "IF") {
    return /\bTHEN\s*$/i.test(statement.operands) ? undefined : "if";
  }
  if (countQuotes(statement.operands) % 2 === 1) return "literal";
  return statement.operands.endsWith(",") ? "operand" : undefined;
}

/** The operand field ends at the first blank outside an apostrophe-delimited literal. */
function operandField(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") quoted = !quoted;
    else if (character === " " && !quoted) return text.slice(0, index);
  }
  return text;
}

function countQuotes(text: string): number {
  let count = 0;
  for (const character of text) if (character === "'") count += 1;
  return count;
}

/** Split operands at top-level commas, honoring parentheses and apostrophes. */
export function splitOperands(text: string): JclOperands {
  const pieces: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of text) {
    if (character === "'") quoted = !quoted;
    if (!quoted) {
      if (character === "(") depth += 1;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === "," && depth === 0) {
        pieces.push(current);
        current = "";
        continue;
      }
    }
    current += character;
  }
  if (current.length > 0 || pieces.length > 0) pieces.push(current);
  const positional: string[] = [];
  const keywords = new Map<string, string>();
  for (const piece of pieces) {
    const match = /^([A-Z0-9@#$]+)=(.*)$/is.exec(piece);
    if (match?.[1] !== undefined) keywords.set(match[1].toUpperCase(), match[2] ?? "");
    else positional.push(piece);
  }
  return { positional, keywords };
}

/** Return the subparameters of `(a,b,c)`; a bare value is one subparameter. */
export function subparameters(value: string): string[] {
  const inner = /^\((.*)\)$/s.exec(value.trim());
  if (!inner) return [value.trim()];
  return splitOperands(inner[1] ?? "").positional.map((piece) => piece.trim());
}

export function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Substitute `&SYMBOL` / `&SYMBOL.` only from same-member `SET` symbols.
 * `&&TEMP` names and unknown symbols stay verbatim; nothing is resolved from
 * procedures, JCLLIB members, or system symbols that this collector cannot see.
 */
export function resolveSymbols(value: string, symbols: ReadonlyMap<string, string>): string {
  return value.replace(/&&|&([A-Z0-9@#$]{1,8})\.?/gi, (match, symbol: string | undefined) => {
    if (match === "&&" || symbol === undefined) return match;
    const resolved = symbols.get(symbol.toUpperCase());
    return resolved === undefined ? match : resolved;
  });
}
