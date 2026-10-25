/**
 * COBOL copybook parser: inert text in, a data-description tree out. It reads
 * level numbers and data-description clauses only; it never follows `COPY`,
 * evaluates `REPLACE`, or interprets procedure code.
 */
import { CLAUSE_KEYWORDS, FIGURATIVE, OCCURS_STOP, USAGE_KEYWORDS } from "./copybook-keywords.js";

export type CopybookFormat = "fixed" | "free";

export type CopybookLiteral =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number; text: string }
  | { kind: "hex"; text: string }
  | { kind: "figurative"; value: string };

export interface CopybookConditionValue {
  from: CopybookLiteral;
  thru?: CopybookLiteral;
}

export interface CopybookOccurs {
  min: number;
  max: number;
  dependingOn?: string;
  indexedBy?: string[];
  keys?: { order: "ASCENDING" | "DESCENDING"; names: string[] }[];
}

export interface CopybookItem {
  level: number;
  name: string;
  filler: boolean;
  picture?: string;
  usage?: string;
  occurs?: CopybookOccurs;
  redefines?: string;
  renames?: { from: string; thru?: string };
  value?: CopybookLiteral;
  conditionValues?: CopybookConditionValue[];
  sign?: { position: "LEADING" | "TRAILING"; separate: boolean };
  justified?: boolean;
  blankWhenZero?: boolean;
  sync?: boolean;
  external?: boolean;
  global?: boolean;
  /** The normalized statement text, clauses included, exactly as parsed. */
  declaration: string;
  line: number;
  children: CopybookItem[];
  /** Level-88 condition names declared under this item. */
  conditions: CopybookItem[];
  /** Level-66 RENAMES declared under this record (01/77 only). */
  renamed: CopybookItem[];
}

export interface CopybookDiagnostic {
  level: "error" | "warning" | "info";
  code: string;
  message: string;
  line?: number;
}

export interface CopybookParseResult {
  format: CopybookFormat;
  roots: CopybookItem[];
  itemCount: number;
  lines: number;
  diagnostics: CopybookDiagnostic[];
}

const MAX_ITEMS = 10_000;
const MAX_STATEMENT_TOKENS = 512;
const LEVEL_PATTERN = /^\d{1,2}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;

interface Token {
  text: string;
  line: number;
  quoted: boolean;
}

interface SourceLine {
  text: string;
  line: number;
  /** A `-` indicator in column 7 continues the previous literal. */
  continuation: boolean;
}

export function parseCopybook(
  text: string,
  requestedFormat: CopybookFormat | "auto" = "auto",
): CopybookParseResult {
  const diagnostics: CopybookDiagnostic[] = [];
  const rawLines = text.split(/\r?\n/);
  const format = requestedFormat === "auto" ? detectFormat(rawLines) : requestedFormat;
  const source = sourceLines(rawLines, format, diagnostics);
  const tokens = tokenize(source);
  const statements = groupStatements(tokens, diagnostics);
  const roots = buildTree(statements, diagnostics);
  return {
    format,
    roots: roots.roots,
    itemCount: roots.itemCount,
    lines: rawLines.length,
    diagnostics,
  };
}

/**
 * Fixed format wins when its columns 8-72 start more statements with a level
 * number than the raw lines do (sequence numbers in columns 1-6 make free
 * parsing fail); otherwise the text is read as free format.
 */
function detectFormat(lines: readonly string[]): CopybookFormat {
  let fixedScore = 0;
  let freeScore = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (/^[0-9 ]{6}[*/]/.test(line)) {
      fixedScore += 1;
      continue;
    }
    if (/^[0-9 ]{6}[ \-dD]/.test(line) && startsWithLevel(line.slice(7, 72))) fixedScore += 1;
    if (startsWithLevel(line)) freeScore += 1;
  }
  return fixedScore >= freeScore ? "fixed" : "free";
}

function startsWithLevel(text: string): boolean {
  return /^\s*(?:\d{1,2}\s+\S|COPY\s|SKIP[123]\b|EJECT\b)/i.test(text);
}

function sourceLines(
  lines: readonly string[],
  format: CopybookFormat,
  diagnostics: CopybookDiagnostic[],
): SourceLine[] {
  const result: SourceLine[] = [];
  let overflow = false;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = index + 1;
    if (format === "fixed") {
      if (raw.length > 80 && !overflow) {
        overflow = true;
        diagnostics.push({
          level: "warning",
          code: "legacy/copybook/column_overflow",
          message: "Fixed-format records longer than 80 columns were truncated at column 72.",
          line,
        });
      }
      if (raw.length < 8) continue;
      const indicator = raw[6];
      if (indicator === "*" || indicator === "/" || indicator === "D" || indicator === "d")
        continue;
      const text = stripInlineComment(raw.slice(7, 72));
      if (text.trim().length === 0) continue;
      result.push({ text, line, continuation: indicator === "-" });
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0 || trimmed.startsWith("*")) continue;
    const text = stripInlineComment(raw);
    if (text.trim().length === 0) continue;
    result.push({ text, line, continuation: false });
  }
  return result;
}

function stripInlineComment(text: string): string {
  let quote: string | undefined;
  for (let index = 0; index < text.length - 1; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === "*" && text[index + 1] === ">") {
      return text.slice(0, index);
    }
  }
  return text;
}

function tokenize(lines: readonly SourceLine[]): Token[] {
  const tokens: Token[] = [];
  let openLiteral: { quote: string; text: string; line: number } | undefined;
  for (const source of lines) {
    let text = source.text;
    if (openLiteral) {
      if (source.continuation) {
        const resumed = text.trimStart();
        text = resumed.startsWith(openLiteral.quote) ? resumed.slice(1) : resumed;
      } else {
        tokens.push({ text: openLiteral.text, line: openLiteral.line, quoted: true });
        openLiteral = undefined;
      }
    }
    let index = 0;
    while (index < text.length) {
      const character = text[index] ?? "";
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }
      if (openLiteral || character === "'" || character === '"') {
        const quote = openLiteral?.quote ?? character;
        let value = openLiteral?.text ?? "";
        let cursor = openLiteral ? index : index + 1;
        let closed = false;
        while (cursor < text.length) {
          const current = text[cursor] ?? "";
          if (current === quote) {
            if (text[cursor + 1] === quote) {
              value += quote;
              cursor += 2;
              continue;
            }
            closed = true;
            cursor += 1;
            break;
          }
          value += current;
          cursor += 1;
        }
        if (!closed) {
          openLiteral = { quote, text: value, line: openLiteral?.line ?? source.line };
          index = text.length;
          continue;
        }
        tokens.push({ text: value, line: openLiteral?.line ?? source.line, quoted: true });
        openLiteral = undefined;
        index = cursor;
        continue;
      }
      let end = index;
      while (end < text.length) {
        const current = text[end] ?? "";
        if (/\s/.test(current) || current === "'" || current === '"') break;
        if (current === "." && (end + 1 >= text.length || /\s/.test(text[end + 1] ?? ""))) break;
        end += 1;
      }
      if (end === index) {
        tokens.push({ text: ".", line: source.line, quoted: false });
        index += 1;
        continue;
      }
      tokens.push({ text: text.slice(index, end), line: source.line, quoted: false });
      index = end;
    }
  }
  if (openLiteral) tokens.push({ text: openLiteral.text, line: openLiteral.line, quoted: true });
  return tokens;
}

function groupStatements(tokens: readonly Token[], diagnostics: CopybookDiagnostic[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  for (const token of tokens) {
    if (!token.quoted && token.text === ".") {
      if (current.length > 0) statements.push(current);
      current = [];
      continue;
    }
    if (current.length < MAX_STATEMENT_TOKENS) current.push(token);
  }
  if (current.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "legacy/copybook/missing_period",
      message: "The last data description has no terminating period; it was read as written.",
      line: current[0]?.line,
    });
    statements.push(current);
  }
  return statements;
}

function buildTree(
  statements: readonly Token[][],
  diagnostics: CopybookDiagnostic[],
): { roots: CopybookItem[]; itemCount: number } {
  const roots: CopybookItem[] = [];
  const stack: CopybookItem[] = [];
  let lastDataItem: CopybookItem | undefined;
  let itemCount = 0;
  let unrecognized = 0;
  for (const statement of statements) {
    const head = statement[0];
    if (!head) continue;
    const keyword = head.text.toUpperCase();
    if (keyword === "COPY") {
      diagnostics.push({
        level: "warning",
        code: "legacy/copybook/copy_not_followed",
        message:
          `COPY ${statement[1]?.text ?? ""} was not followed; nested copybooks must be supplied expanded.`.trim(),
        line: head.line,
      });
      continue;
    }
    if (/^(?:SKIP[123]|EJECT|TITLE)$/.test(keyword)) continue;
    if (!LEVEL_PATTERN.test(head.text)) {
      unrecognized += 1;
      if (unrecognized <= 5) {
        diagnostics.push({
          level: "warning",
          code: "legacy/copybook/unrecognized_statement",
          message: `Ignored a statement that does not begin with a level number: '${head.text.slice(0, 40)}'.`,
          line: head.line,
        });
      }
      continue;
    }
    const level = Number.parseInt(head.text, 10);
    if (!((level >= 1 && level <= 49) || level === 66 || level === 77 || level === 88)) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/invalid_level",
        message: `Level number ${head.text} is not valid in a data description.`,
        line: head.line,
      });
      continue;
    }
    if (itemCount >= MAX_ITEMS) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/too_many_items",
        message: `Stopped after ${MAX_ITEMS} data items.`,
        line: head.line,
      });
      break;
    }
    const item = parseItem(level, statement, diagnostics);
    if (!item) continue;
    itemCount += 1;

    if (level === 88) {
      if (!lastDataItem) {
        diagnostics.push({
          level: "error",
          code: "legacy/copybook/orphan_condition",
          message: `Condition name ${item.name} has no preceding data item.`,
          line: item.line,
        });
        continue;
      }
      lastDataItem.conditions.push(item);
      continue;
    }
    if (level === 66) {
      const root = roots.at(-1);
      if (!root) {
        diagnostics.push({
          level: "error",
          code: "legacy/copybook/orphan_renames",
          message: `RENAMES item ${item.name} has no preceding record.`,
          line: item.line,
        });
        continue;
      }
      root.renamed.push(item);
      continue;
    }
    if (level === 1 || level === 77) {
      stack.length = 0;
      roots.push(item);
      stack.push(item);
      lastDataItem = item;
      continue;
    }
    while (stack.length > 0 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const parent = stack.at(-1);
    if (!parent) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/orphan_item",
        message: `Level ${head.text} item ${item.name} appears before any 01-level record.`,
        line: item.line,
      });
      continue;
    }
    if (parent.level === 77) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/subordinate_of_77",
        message: `Level ${head.text} item ${item.name} cannot be subordinate to level-77 item ${parent.name}.`,
        line: item.line,
      });
      continue;
    }
    parent.children.push(item);
    stack.push(item);
    lastDataItem = item;
  }
  return { roots, itemCount };
}

function parseItem(
  level: number,
  statement: readonly Token[],
  diagnostics: CopybookDiagnostic[],
): CopybookItem | undefined {
  const head = statement[0];
  if (!head) return undefined;
  let cursor = 1;
  let name = "FILLER";
  let filler = true;
  const nameToken = statement[1];
  if (nameToken && !nameToken.quoted && !CLAUSE_KEYWORDS.has(nameToken.text.toUpperCase())) {
    if (!NAME_PATTERN.test(nameToken.text)) {
      diagnostics.push({
        level: "error",
        code: "legacy/copybook/invalid_name",
        message: `'${nameToken.text.slice(0, 40)}' is not a valid data name.`,
        line: nameToken.line,
      });
      return undefined;
    }
    name = nameToken.text;
    filler = false;
    cursor = 2;
  } else if (nameToken && !nameToken.quoted && nameToken.text.toUpperCase() === "FILLER") {
    cursor = 2;
  }
  const item: CopybookItem = {
    level,
    name,
    filler,
    declaration: statement
      .map((token) => (token.quoted ? `'${token.text.replace(/'/g, "''")}'` : token.text))
      .join(" "),
    line: head.line,
    children: [],
    conditions: [],
    renamed: [],
  };
  const unknown: string[] = [];
  const upper = (index: number): string | undefined => {
    const token = statement[index];
    return token && !token.quoted ? token.text.toUpperCase() : undefined;
  };
  const skipNoise = (...words: string[]): void => {
    while (cursor < statement.length && words.includes(upper(cursor) ?? "")) cursor += 1;
  };
  while (cursor < statement.length) {
    const token = statement[cursor];
    if (!token) break;
    const word = token.quoted ? undefined : token.text.toUpperCase();
    cursor += 1;
    switch (word) {
      case "PIC":
      case "PICTURE": {
        skipNoise("IS");
        let picture = statement[cursor]?.text ?? "";
        cursor += 1;
        while (statement[cursor]?.text.startsWith("(") && !statement[cursor]?.quoted) {
          picture += statement[cursor]?.text ?? "";
          cursor += 1;
        }
        item.picture = picture.toUpperCase();
        break;
      }
      case "USAGE": {
        skipNoise("IS");
        const usage = upper(cursor);
        if (usage && USAGE_KEYWORDS.has(usage)) {
          item.usage = usage;
          cursor += 1;
        }
        break;
      }
      case "REDEFINES":
        item.redefines = statement[cursor]?.text;
        cursor += 1;
        break;
      case "RENAMES": {
        const from = statement[cursor]?.text;
        cursor += 1;
        if (from) item.renames = { from };
        if (["THRU", "THROUGH"].includes(upper(cursor) ?? "")) {
          cursor += 1;
          const thru = statement[cursor]?.text;
          cursor += 1;
          if (item.renames && thru) item.renames.thru = thru;
        }
        break;
      }
      case "OCCURS": {
        const occurs = parseOccurs(statement, cursor, upper);
        cursor = occurs.cursor;
        item.occurs = occurs.value;
        break;
      }
      case "VALUE":
      case "VALUES": {
        skipNoise("IS", "ARE");
        const values: CopybookConditionValue[] = [];
        while (cursor < statement.length) {
          const parsed = literalAt(statement, cursor);
          if (!parsed) break;
          cursor = parsed.next;
          const value: CopybookConditionValue = { from: parsed.literal };
          if (["THRU", "THROUGH"].includes(upper(cursor) ?? "")) {
            cursor += 1;
            const thru = literalAt(statement, cursor);
            if (thru) {
              value.thru = thru.literal;
              cursor = thru.next;
            }
          }
          values.push(value);
          if (level !== 88) break;
        }
        if (level === 88) item.conditionValues = values;
        else if (values[0]) item.value = values[0].from;
        break;
      }
      case "SIGN": {
        skipNoise("IS");
        const position = upper(cursor);
        if (position === "LEADING" || position === "TRAILING") {
          cursor += 1;
          item.sign = { position, separate: false };
          if (upper(cursor) === "SEPARATE") {
            cursor += 1;
            item.sign.separate = true;
            skipNoise("CHARACTER");
          }
        }
        break;
      }
      case "LEADING":
      case "TRAILING": {
        item.sign = { position: word, separate: false };
        if (upper(cursor) === "SEPARATE") {
          cursor += 1;
          item.sign.separate = true;
          skipNoise("CHARACTER");
        }
        break;
      }
      case "JUST":
      case "JUSTIFIED":
        skipNoise("RIGHT");
        item.justified = true;
        break;
      case "BLANK":
        skipNoise("WHEN", "ZERO", "ZEROS", "ZEROES");
        item.blankWhenZero = true;
        break;
      case "SYNC":
      case "SYNCHRONIZED":
        skipNoise("LEFT", "RIGHT");
        item.sync = true;
        break;
      case "GLOBAL":
        item.global = true;
        break;
      case "EXTERNAL":
        item.external = true;
        break;
      case "FILLER":
        break;
      default:
        if (word && USAGE_KEYWORDS.has(word)) {
          item.usage = word;
          break;
        }
        unknown.push(token.text);
    }
  }
  if (unknown.length > 0) {
    diagnostics.push({
      level: "warning",
      code: "legacy/copybook/unsupported_clause",
      message: `${item.name}: ignored clause tokens ${unknown
        .slice(0, 5)
        .map((text) => `'${text.slice(0, 32)}'`)
        .join(", ")}.`,
      line: item.line,
    });
  }
  return item;
}

function parseOccurs(
  statement: readonly Token[],
  start: number,
  upper: (index: number) => string | undefined,
): { cursor: number; value: CopybookOccurs } {
  let cursor = start;
  const first = Number.parseInt(statement[cursor]?.text ?? "", 10);
  cursor += 1;
  const value: CopybookOccurs = {
    min: Number.isFinite(first) ? first : 0,
    max: Number.isFinite(first) ? first : 0,
  };
  if (upper(cursor) === "TO") {
    cursor += 1;
    const max = Number.parseInt(statement[cursor]?.text ?? "", 10);
    cursor += 1;
    if (Number.isFinite(max)) value.max = max;
  }
  if (upper(cursor) === "TIMES") cursor += 1;
  while (cursor < statement.length) {
    const word = upper(cursor);
    if (word === "DEPENDING") {
      cursor += 1;
      if (upper(cursor) === "ON") cursor += 1;
      value.dependingOn = statement[cursor]?.text;
      cursor += 1;
      continue;
    }
    if (word === "INDEXED") {
      cursor += 1;
      if (upper(cursor) === "BY") cursor += 1;
      value.indexedBy = value.indexedBy ?? [];
      while (cursor < statement.length && isNameToken(statement[cursor], upper(cursor))) {
        value.indexedBy.push(statement[cursor]?.text ?? "");
        cursor += 1;
      }
      continue;
    }
    if (word === "ASCENDING" || word === "DESCENDING") {
      cursor += 1;
      if (upper(cursor) === "KEY") cursor += 1;
      if (upper(cursor) === "IS") cursor += 1;
      const names: string[] = [];
      while (cursor < statement.length && isNameToken(statement[cursor], upper(cursor))) {
        names.push(statement[cursor]?.text ?? "");
        cursor += 1;
      }
      value.keys = [...(value.keys ?? []), { order: word, names }];
      continue;
    }
    break;
  }
  return { cursor, value };
}

function isNameToken(token: Token | undefined, upper: string | undefined): boolean {
  return (
    token !== undefined &&
    !token.quoted &&
    upper !== undefined &&
    !OCCURS_STOP.has(upper) &&
    NAME_PATTERN.test(token.text)
  );
}

/** Read one literal at `cursor`, including `X'..'` hex and `ALL '..'` forms that span two tokens. */
function literalAt(
  statement: readonly Token[],
  cursor: number,
): { literal: CopybookLiteral; next: number } | undefined {
  const token = statement[cursor];
  const following = statement[cursor + 1];
  if (!token) return undefined;
  if (!token.quoted && following?.quoted) {
    const prefix = token.text.toUpperCase();
    if (/^[XHNGZ]$/.test(prefix)) {
      return { literal: { kind: "hex", text: `${prefix}'${following.text}'` }, next: cursor + 2 };
    }
    if (prefix === "ALL") {
      return {
        literal: { kind: "figurative", value: `ALL '${following.text}'` },
        next: cursor + 2,
      };
    }
  }
  const literal = parseLiteral(token);
  return literal ? { literal, next: cursor + 1 } : undefined;
}

function parseLiteral(token: Token | undefined): CopybookLiteral | undefined {
  if (!token) return undefined;
  if (token.quoted) return { kind: "string", value: token.text };
  const upper = token.text.toUpperCase();
  if (FIGURATIVE.has(upper)) return { kind: "figurative", value: upper };
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token.text)) {
    const value = Number(token.text);
    if (Number.isFinite(value)) return { kind: "number", value, text: token.text };
  }
  return undefined;
}
