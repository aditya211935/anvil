/**
 * Inert-text preparation for C# source. The scaffold never loads an assembly
 * or evaluates code: it reads the characters the compiler would, blanks what
 * can never carry a routing fact (comments, string and character literal
 * contents, preprocessor lines) and keeps a side table of the literal values
 * so attribute arguments such as `[Route("api/[controller]")]` are still
 * readable at their exact offset. Every offset in the masked text equals the
 * offset in the original, so evidence lines are always exact.
 */

export interface CSharpText {
  path: string;
  /** Same length as the decoded source; comments, literal contents and `#` lines are spaces. */
  masked: string;
  /** Opening-quote offset in `masked` → the literal's value. */
  literals: Map<number, string>;
  lineStarts: number[];
}

export interface CSharpAttributeArg {
  kind: "string" | "typeof" | "other";
  /** The literal value, the `typeof` operand, or the raw text. */
  value: string;
  offset: number;
}

export interface CSharpAttribute {
  /** Last segment of the attribute type, `Attribute` suffix removed (`HttpGet`). */
  name: string;
  positional: CSharpAttributeArg[];
  named: Map<string, CSharpAttributeArg>;
  /** Offset of the attribute name. */
  offset: number;
}

/** One class-member or file-level statement: its header text and optional block. */
export interface CSharpStatement {
  start: number;
  /** End of the header (exclusive): the `{`, `;` or `=>` that terminated it. */
  headerEnd: number;
  terminator: "block" | "semicolon" | "expression" | "end";
  block?: { start: number; end: number };
}

const MODIFIERS =
  /^(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|extern|new|partial|unsafe|readonly|required|volatile|const|file)$/;

export function prepareCSharpText(path: string, text: string): CSharpText {
  const source = text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text;
  const out: string[] = [];
  const literals = new Map<number, string>();
  const length = source.length;
  let i = 0;
  let lineStart = true;
  while (i < length) {
    const ch = source[i] as string;
    const next = source[i + 1];
    if (lineStart && ch === "#") {
      const end = lineEnd(source, i);
      out.push(" ".repeat(end - i));
      i = end;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = lineEnd(source, i);
      out.push(" ".repeat(end - i));
      i = end;
      continue;
    }
    if (ch === "/" && next === "*") {
      let end = source.indexOf("*/", i + 2);
      end = end === -1 ? length : end + 2;
      out.push(blankKeepingNewlines(source.slice(i, end)));
      i = end;
      continue;
    }
    if (ch === '"' || ((ch === "@" || ch === "$") && isStringStart(source, i))) {
      const literal = readStringLiteral(source, i);
      literals.set(literal.quote, literal.value);
      out.push(
        " ".repeat(literal.quote - i),
        '"',
        blankKeepingNewlines(
          source.slice(literal.quote + 1, Math.max(literal.quote + 1, literal.end - 1)),
        ),
        literal.end > literal.quote + 1 ? '"' : "",
      );
      i = literal.end;
      lineStart = false;
      continue;
    }
    if (ch === "'") {
      const end = readCharLiteral(source, i);
      out.push("'", " ".repeat(Math.max(0, end - i - 2)), end - i >= 2 ? "'" : "");
      i = end;
      lineStart = false;
      continue;
    }
    out.push(ch);
    if (ch === "\n") lineStart = true;
    else if (ch !== " " && ch !== "\t" && ch !== "\r") lineStart = false;
    i += 1;
  }
  const masked = out.join("");
  const lineStarts = [0];
  for (let k = 0; k < masked.length; k += 1) {
    if (masked.charCodeAt(k) === 10) lineStarts.push(k + 1);
  }
  return { path, masked, literals, lineStarts };
}

/** 1-based line of an offset. */
export function lineAt(file: CSharpText, offset: number): number {
  let low = 0;
  let high = file.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((file.lineStarts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf("\n", from);
  return end === -1 ? source.length : end;
}

function blankKeepingNewlines(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

function isStringStart(source: string, i: number): boolean {
  const a = source[i];
  const b = source[i + 1];
  const c = source[i + 2];
  if (b === '"') return a === "@" || a === "$";
  return ((a === "@" && b === "$") || (a === "$" && b === "@")) && c === '"';
}

function readStringLiteral(
  source: string,
  start: number,
): { quote: number; end: number; value: string } {
  let quote = start;
  let verbatim = false;
  while (source[quote] === "@" || source[quote] === "$") {
    if (source[quote] === "@") verbatim = true;
    quote += 1;
  }
  const length = source.length;
  if (source.startsWith('"""', quote)) {
    let fence = 3;
    while (source[quote + fence] === '"') fence += 1;
    const close = source.indexOf('"'.repeat(fence), quote + fence);
    const end = close === -1 ? length : close + fence;
    const raw = source.slice(quote + fence, close === -1 ? length : close);
    return {
      quote,
      end,
      value: raw
        .replace(/^\s*\n/, "")
        .replace(/\n\s*$/, "")
        .trim(),
    };
  }
  let i = quote + 1;
  let value = "";
  while (i < length) {
    const ch = source[i] as string;
    if (verbatim) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i += 2;
          continue;
        }
        return { quote, end: i + 1, value };
      }
      value += ch;
      i += 1;
      continue;
    }
    if (ch === "\n") return { quote, end: i, value };
    if (ch === "\\" && i + 1 < length) {
      const escaped = source[i + 1] as string;
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        "0": "\0",
        '"': '"',
        "'": "'",
        "\\": "\\",
      };
      if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6))) {
        value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      value += simple[escaped] ?? escaped;
      i += 2;
      continue;
    }
    if (ch === '"') return { quote, end: i + 1, value };
    value += ch;
    i += 1;
  }
  return { quote, end: length, value };
}

function readCharLiteral(source: string, start: number): number {
  let i = start + 1;
  const limit = Math.min(source.length, start + 12);
  while (i < limit) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === "\n") return ch === "'" ? i + 1 : i;
    i += 1;
  }
  return Math.min(i, source.length);
}

/** Index of the bracket closing the one at `open`, or `to` when unbalanced. */
export function matchBracket(masked: string, open: number, to: number): number {
  const openChar = masked[open];
  const closeChar = openChar === "{" ? "}" : openChar === "(" ? ")" : openChar === "[" ? "]" : ">";
  let depth = 0;
  for (let i = open; i < to; i += 1) {
    const ch = masked[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return to;
}

/**
 * Split `[from, to)` into statements at nesting depth 0. A statement ends at
 * the `;` or `=>` that terminates it or at the `{` that opens its block (the
 * block is skipped, not descended). Parentheses and attribute brackets are
 * honoured so a `{` inside `[Route("{id}")]` or a default argument never ends
 * a header early. Unbalanced input ends at `to`.
 */
export function splitStatements(masked: string, from: number, to: number): CSharpStatement[] {
  const statements: CSharpStatement[] = [];
  let start = from;
  let depth = 0;
  let i = from;
  while (i < to) {
    const ch = masked[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "{") {
      const close = matchBracket(masked, i, to);
      push(statements, masked, start, i, "block", { start: i + 1, end: close });
      i = close + 1;
      start = i;
      continue;
    } else if (depth === 0 && ch === ";") {
      push(statements, masked, start, i, "semicolon");
      start = i + 1;
    } else if (depth === 0 && ch === "=" && masked[i + 1] === ">") {
      // Expression body: the header is complete; skip to the terminating `;`.
      const end = expressionEnd(masked, i + 2, to);
      push(statements, masked, start, i, "expression");
      i = end + 1;
      start = i;
      continue;
    }
    i += 1;
  }
  if (masked.slice(start, to).trim().length > 0) push(statements, masked, start, to, "end");
  return statements;
}

function expressionEnd(masked: string, from: number, to: number): number {
  let depth = 0;
  for (let i = from; i < to; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === ";" && depth <= 0) return i;
  }
  return to;
}

function push(
  statements: CSharpStatement[],
  masked: string,
  start: number,
  headerEnd: number,
  terminator: CSharpStatement["terminator"],
  block?: { start: number; end: number },
): void {
  while (start < headerEnd && /\s/.test(masked[start] as string)) start += 1;
  if (start >= headerEnd && !block) return;
  statements.push({ start, headerEnd, terminator, ...(block ? { block } : {}) });
}

/**
 * Read the attribute sections at the start of `[from, to)`. Returns the
 * attributes and the offset just past the last section. `[return: …]` and
 * other targeted sections are skipped; array types such as `int[]` are not
 * attribute sections and stop the scan.
 */
export function parseAttributeSections(
  file: CSharpText,
  from: number,
  to: number,
): { attributes: CSharpAttribute[]; next: number } {
  const { masked } = file;
  const attributes: CSharpAttribute[] = [];
  let i = from;
  for (;;) {
    while (i < to && /\s/.test(masked[i] as string)) i += 1;
    if (i >= to || masked[i] !== "[") break;
    const inner = masked.slice(i + 1, Math.min(to, i + 64));
    if (!/^\s*(?:[A-Za-z_]\w*\s*:\s*)?[A-Za-z_]/.test(inner)) break;
    const close = matchBracket(masked, i, to);
    if (close >= to) {
      i = to;
      break;
    }
    let bodyStart = i + 1;
    const target = /^\s*([A-Za-z_]\w*)\s*:/.exec(masked.slice(bodyStart, close));
    if (target) {
      bodyStart += target[0].length;
      if (target[1] !== "method" && target[1] !== "type") {
        i = close + 1;
        continue;
      }
    }
    for (const part of splitTopLevel(masked, bodyStart, close)) {
      const attribute = parseAttribute(file, part.start, part.end);
      if (attribute) attributes.push(attribute);
    }
    i = close + 1;
  }
  return { attributes, next: i };
}

function parseAttribute(file: CSharpText, start: number, end: number): CSharpAttribute | undefined {
  const text = file.masked.slice(start, end);
  const head = /^\s*([A-Za-z_][\w.]*)\s*(?:<[^>]*>)?\s*(\(|$)/.exec(text);
  if (!head) return undefined;
  const nameOffset = start + (head[0].length - head[0].trimStart().length);
  const qualified = head[1] as string;
  const name = (qualified.split(".").at(-1) ?? qualified).replace(/Attribute$/, "");
  const attribute: CSharpAttribute = { name, positional: [], named: new Map(), offset: nameOffset };
  if (head[2] === "(") {
    const open = start + head[0].length - 1;
    const close = matchBracket(file.masked, open, end);
    for (const part of splitTopLevel(file.masked, open + 1, close)) {
      const partText = file.masked.slice(part.start, part.end);
      const named = /^\s*([A-Za-z_]\w*)\s*(?:=(?!=)|:)\s*/.exec(partText);
      if (named) {
        attribute.named.set(
          named[1] as string,
          parseArg(file, part.start + named[0].length, part.end),
        );
      } else if (partText.trim().length > 0) {
        attribute.positional.push(parseArg(file, part.start, part.end));
      }
    }
  }
  return attribute;
}

function parseArg(file: CSharpText, start: number, end: number): CSharpAttributeArg {
  const text = file.masked.slice(start, end);
  const trimmed = text.trim();
  const offset = start + (text.length - text.trimStart().length);
  const quote = file.masked.indexOf('"', offset);
  if (/^[@$]*"/.test(trimmed) && quote !== -1 && quote < end) {
    return { kind: "string", value: file.literals.get(quote) ?? "", offset };
  }
  const typeOf = /^typeof\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
  if (typeOf) return { kind: "typeof", value: (typeOf[1] as string).trim(), offset };
  return { kind: "other", value: trimmed, offset };
}

/** Split `[from, to)` on top-level commas, honouring `()`, `[]`, `{}` and `<>`. */
export function splitTopLevel(
  masked: string,
  from: number,
  to: number,
): { start: number; end: number }[] {
  const parts: { start: number; end: number }[] = [];
  let depth = 0;
  let angle = 0;
  let start = from;
  for (let i = from; i < to; i += 1) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "<") angle += 1;
    else if (ch === ">") angle = Math.max(0, angle - 1);
    else if (ch === "," && depth === 0 && angle === 0) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  if (to > start || parts.length > 0) parts.push({ start, end: to });
  return parts.filter((part) => masked.slice(part.start, part.end).trim().length > 0);
}

/** Split leading C# modifiers off a declaration header. */
export function stripModifiers(text: string): { modifiers: string[]; rest: string } {
  const modifiers: string[] = [];
  let rest = text.trimStart();
  for (;;) {
    const word = /^([A-Za-z_]\w*)\s+/.exec(rest);
    if (!word || !MODIFIERS.test(word[1] as string)) break;
    modifiers.push(word[1] as string);
    rest = rest.slice(word[0].length);
  }
  return { modifiers, rest };
}

/** Decode a source member as UTF-8; `undefined` when the bytes are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
