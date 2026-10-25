import { maskAnnotationComments } from "../collectors/java-ee/source.js";

/**
 * The literal content of one annotation element, read without evaluation.
 * A string literal, a boolean, a number, an identifier chain such as
 * `RequestMethod.GET` or `MediaType.APPLICATION_JSON`, and a `Foo.class`
 * reference are recorded as written; an operator, a call, or a nested
 * annotation marks the value `unsupported` so no caller mistakes a
 * concatenated constant for the string it would evaluate to.
 */
export interface AnnotationValue {
  strings: string[];
  identifiers: string[];
  booleans: boolean[];
  numbers: string[];
  classRefs: string[];
  unsupported: boolean;
}

export interface AnnotationArguments {
  /** The single unnamed element: `@Path("/orders")`. */
  positional?: AnnotationValue;
  named: Map<string, AnnotationValue>;
  /** The body could not be split into `name = value` elements. */
  malformed: boolean;
}

type Token =
  | { kind: "string"; value: string }
  | { kind: "ident"; value: string }
  | { kind: "number"; value: string }
  | { kind: "punct"; value: string };

function emptyArguments(): AnnotationArguments {
  return { named: new Map(), malformed: false };
}

/** Parse the text between an annotation's parentheses as inert data. */
export function parseAnnotationArguments(body: string | undefined): AnnotationArguments {
  if (body === undefined || body.trim() === "") return emptyArguments();
  const tokens = tokenize(maskAnnotationComments(body));
  if (!tokens) return { named: new Map(), malformed: true };
  const named = new Map<string, AnnotationValue>();
  let positional: AnnotationValue | undefined;
  let malformed = false;
  for (const element of splitTokens(tokens)) {
    const [first, second] = element;
    if (element.length === 0) {
      malformed = true;
      continue;
    }
    if (first?.kind === "ident" && second?.kind === "punct" && second.value === "=") {
      named.set(first.value, elementValue(element.slice(2)));
    } else if (positional === undefined && named.size === 0) {
      positional = elementValue(element);
    } else {
      malformed = true;
    }
  }
  return { ...(positional ? { positional } : {}), named, malformed };
}

/**
 * The element a caller reads under one of several names: `value` is the
 * positional element, `path` is Spring's alias for it.
 */
export function argumentValue(
  args: AnnotationArguments,
  names: readonly string[],
): AnnotationValue | undefined {
  for (const name of names) {
    const value = args.named.get(name);
    if (value) return value;
  }
  return names.includes("value") ? args.positional : undefined;
}

/** The single boolean of a named element, when it was written as a literal. */
export function booleanArgument(args: AnnotationArguments, name: string): boolean | undefined {
  const value = args.named.get(name);
  if (!value || value.unsupported || value.booleans.length !== 1) return undefined;
  return value.booleans[0];
}

function elementValue(tokens: Token[]): AnnotationValue {
  const value: AnnotationValue = {
    strings: [],
    identifiers: [],
    booleans: [],
    numbers: [],
    classRefs: [],
    unsupported: false,
  };
  let inner = tokens;
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (
    first?.kind === "punct" &&
    first.value === "{" &&
    last?.kind === "punct" &&
    last.value === "}"
  ) {
    inner = tokens.slice(1, -1);
  }
  for (const item of splitTokens(inner)) {
    const token = item[0];
    if (item.length !== 1 || !token) {
      if (item.length > 0) value.unsupported = true;
      continue;
    }
    if (token.kind === "string") value.strings.push(token.value);
    else if (token.kind === "number") value.numbers.push(token.value);
    else if (token.kind === "ident") {
      if (token.value === "true" || token.value === "false") {
        value.booleans.push(token.value === "true");
      } else if (token.value.endsWith(".class")) {
        value.classRefs.push(token.value.slice(0, -".class".length));
      } else value.identifiers.push(token.value);
    } else value.unsupported = true;
  }
  return value;
}

/** Split at top-level commas; braces and parentheses nest. */
function splitTokens(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === "punct") {
      if (token.value === "{" || token.value === "(") depth += 1;
      else if (token.value === "}" || token.value === ")") depth = Math.max(0, depth - 1);
      else if (token.value === "," && depth === 0) {
        out.push(current);
        current = [];
        continue;
      }
    }
    current.push(token);
  }
  if (current.length > 0 || out.length > 0) out.push(current);
  return out;
}

const PUNCTUATION = new Set([..."{}(),=+-@<>?:!&|*/%~^[]"]);

function tokenize(body: string): Token[] | undefined {
  const tokens: Token[] = [];
  let index = 0;
  while (index < body.length) {
    const char = body[index] ?? "";
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      if (body.startsWith('"""', index)) {
        const close = body.indexOf('"""', index + 3);
        if (close < 0) return undefined;
        tokens.push({ kind: "string", value: body.slice(index + 3, close) });
        index = close + 3;
        continue;
      }
      const literal = readLiteral(body, index, char);
      if (!literal) return undefined;
      tokens.push({ kind: "string", value: literal.value });
      index = literal.end;
      continue;
    }
    const ident = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/u.exec(body.slice(index));
    if (ident) {
      tokens.push({ kind: "ident", value: ident[0].replace(/\s+/gu, "") });
      index += ident[0].length;
      continue;
    }
    const number = /^-?\d[\w.]*/u.exec(body.slice(index));
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    if (PUNCTUATION.has(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function readLiteral(
  body: string,
  start: number,
  quote: string,
): { value: string; end: number } | undefined {
  let value = "";
  let index = start + 1;
  while (index < body.length) {
    const char = body[index] ?? "";
    if (char === "\\") {
      const escaped = body[index + 1] ?? "";
      if (escaped === "u") {
        const hex = body.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/u.test(hex)) {
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
      }
      value += ESCAPES[escaped] ?? escaped;
      index += 2;
      continue;
    }
    if (char === quote) return { value, end: index + 1 };
    value += char;
    index += 1;
  }
  return undefined;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  "0": "\0",
  s: " ",
};
