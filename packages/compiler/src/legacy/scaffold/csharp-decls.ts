/**
 * Structural reading of C# declarations over masked text (`csharp-text.ts`):
 * namespaces, type declarations, their public members and parameter lists.
 * Headers are read with bounded regular expressions on one statement at a
 * time; a header that does not parse is skipped, never guessed at.
 */

import {
  type CSharpAttribute,
  type CSharpStatement,
  type CSharpText,
  matchBracket,
  parseAttributeSections,
  splitStatements,
  splitTopLevel,
  stripModifiers,
} from "./csharp-text.js";

export interface CSharpTypeDecl {
  file: CSharpText;
  kind: "class" | "record" | "struct" | "interface" | "enum";
  name: string;
  namespace?: string;
  attributes: CSharpAttribute[];
  modifiers: string[];
  /** Base types by last segment, generic arguments removed (`ControllerBase`). */
  bases: string[];
  /** Offset of the type name. */
  offset: number;
  body?: { start: number; end: number };
  /** A record's primary-constructor parameter list. */
  primaryParameters?: CSharpParameter[];
}

export interface CSharpParameter {
  name: string;
  /** Declared type, verbatim. */
  type: string;
  attributes: CSharpAttribute[];
  modifiers: string[];
  hasDefault: boolean;
  /** Offset of the parameter name. */
  offset: number;
}

export interface CSharpMethod {
  name: string;
  returnType: string;
  attributes: CSharpAttribute[];
  modifiers: string[];
  parameters: CSharpParameter[];
  /** Offset of the method name. */
  offset: number;
}

export interface CSharpProperty {
  name: string;
  type: string;
  attributes: CSharpAttribute[];
  modifiers: string[];
  offset: number;
}

/** A header longer than this is not a declaration the scaffold reads. */
const MAX_HEADER_CHARS = 16 * 1024;

/** A C# type expression: dotted name, bounded generic nesting, `?`, array ranks. */
const TYPE_PATTERN = String.raw`[A-Za-z_][\w.]*(?:<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\??(?:\[\s*,*\s*\]\??)*`;

const TYPE_HEADER =
  /^(class|record\s+class|record\s+struct|record|struct|interface|enum)\s+([A-Za-z_]\w*)\s*(<[^>]*>)?\s*/;
const NAMESPACE_HEADER = /^namespace\s+([A-Za-z_][\w.]*)\s*$/;
const METHOD_HEADER = new RegExp(
  String.raw`^(${TYPE_PATTERN})\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(`,
);
const PROPERTY_HEADER = new RegExp(String.raw`^(${TYPE_PATTERN})\s+([A-Za-z_]\w*)\s*$`);
const PARAMETER = new RegExp(
  String.raw`^((?:(?:this|ref|out|in|params|scoped)\s+)*)(${TYPE_PATTERN})\s+([A-Za-z_]\w*)\s*(=[\s\S]*)?$`,
);

/** Every type declared in a file, including nested types, in source order. */
export function collectTypeDeclarations(file: CSharpText): CSharpTypeDecl[] {
  const declarations: CSharpTypeDecl[] = [];
  collectInRange(file, 0, file.masked.length, undefined, declarations, 0);
  return declarations;
}

function collectInRange(
  file: CSharpText,
  from: number,
  to: number,
  namespace: string | undefined,
  out: CSharpTypeDecl[],
  depth: number,
): void {
  if (depth > 8) return;
  let scope = namespace;
  for (const statement of splitStatements(file.masked, from, to)) {
    if (statement.headerEnd - statement.start > MAX_HEADER_CHARS) continue;
    const { attributes, next } = parseAttributeSections(file, statement.start, statement.headerEnd);
    const header = file.masked.slice(next, statement.headerEnd);
    const { modifiers, rest } = stripModifiers(header);
    const ns = NAMESPACE_HEADER.exec(rest.trim());
    if (ns) {
      if (statement.block) {
        collectInRange(file, statement.block.start, statement.block.end, ns[1], out, depth + 1);
      } else {
        scope = ns[1];
      }
      continue;
    }
    const decl = parseTypeHeader(file, statement, attributes, modifiers, rest, scope);
    if (!decl) continue;
    out.push(decl);
    if (decl.body && decl.kind !== "enum") {
      collectInRange(file, decl.body.start, decl.body.end, scope, out, depth + 1);
    }
  }
}

function parseTypeHeader(
  file: CSharpText,
  statement: CSharpStatement,
  attributes: CSharpAttribute[],
  modifiers: string[],
  rest: string,
  namespace: string | undefined,
): CSharpTypeDecl | undefined {
  const match = TYPE_HEADER.exec(rest);
  if (!match) return undefined;
  const keyword = (match[1] as string).replace(/\s+/g, " ");
  const kind: CSharpTypeDecl["kind"] = keyword.startsWith("record")
    ? "record"
    : (keyword as CSharpTypeDecl["kind"]);
  const name = match[2] as string;
  const restStart = statement.headerEnd - rest.length;
  const nameOffset = restStart + match[0].indexOf(name, (match[1] as string).length);
  let cursor = restStart + match[0].length;
  let primaryParameters: CSharpParameter[] | undefined;
  if (file.masked[cursor] === "(") {
    const close = matchBracket(file.masked, cursor, statement.headerEnd);
    primaryParameters = parseParameterList(file, cursor + 1, close);
    cursor = Math.min(close + 1, statement.headerEnd);
  }
  const tail = file.masked.slice(cursor, statement.headerEnd);
  const colon = tail.indexOf(":");
  const bases: string[] = [];
  if (colon !== -1) {
    const baseText = tail.slice(colon + 1).replace(/\bwhere\b[\s\S]*$/, "");
    const offset = cursor + colon + 1;
    for (const part of splitTopLevel(file.masked, offset, offset + baseText.length)) {
      const base = lastSegment(file.masked.slice(part.start, part.end));
      if (base) bases.push(base);
    }
  }
  return {
    file,
    kind,
    name,
    ...(namespace ? { namespace } : {}),
    attributes,
    modifiers,
    bases,
    offset: nameOffset,
    ...(statement.block ? { body: statement.block } : {}),
    ...(primaryParameters ? { primaryParameters } : {}),
  };
}

/** The last dotted segment of a type reference with generic arguments removed. */
export function lastSegment(type: string): string {
  const trimmed = type.trim().replace(/^global::/, "");
  const generic = trimmed.indexOf("<");
  const head = generic === -1 ? trimmed : trimmed.slice(0, generic);
  return head.split(".").at(-1)?.trim() ?? "";
}

/** The methods and properties declared directly in a type body. */
export function classMembers(decl: CSharpTypeDecl): {
  methods: CSharpMethod[];
  properties: CSharpProperty[];
} {
  const methods: CSharpMethod[] = [];
  const properties: CSharpProperty[] = [];
  if (!decl.body) return { methods, properties };
  const { file } = decl;
  for (const statement of splitStatements(file.masked, decl.body.start, decl.body.end)) {
    if (statement.headerEnd - statement.start > MAX_HEADER_CHARS) continue;
    const { attributes, next } = parseAttributeSections(file, statement.start, statement.headerEnd);
    const header = file.masked.slice(next, statement.headerEnd);
    const { modifiers, rest } = stripModifiers(header);
    if (
      /^(?:class|record|struct|interface|enum|namespace|delegate|event|operator|using)\b/.test(rest)
    ) {
      continue;
    }
    const restStart = statement.headerEnd - rest.length;
    const method = METHOD_HEADER.exec(rest);
    if (method) {
      const open = restStart + method[0].length - 1;
      const close = matchBracket(file.masked, open, statement.headerEnd);
      methods.push({
        name: method[2] as string,
        returnType: (method[1] as string).trim(),
        attributes,
        modifiers,
        parameters: parseParameterList(file, open + 1, close),
        offset: restStart + method[0].lastIndexOf(method[2] as string, method[0].length - 1),
      });
      continue;
    }
    if (statement.terminator === "block" || statement.terminator === "expression") {
      const property = PROPERTY_HEADER.exec(rest.trim());
      if (property) {
        properties.push({
          name: property[2] as string,
          type: (property[1] as string).trim(),
          attributes,
          modifiers,
          offset: restStart + rest.lastIndexOf(property[2] as string),
        });
      }
    }
  }
  return { methods, properties };
}

/** Parse a `(` … `)` parameter list given the offsets just inside the parentheses. */
function parseParameterList(file: CSharpText, from: number, to: number): CSharpParameter[] {
  const parameters: CSharpParameter[] = [];
  for (const part of splitTopLevel(file.masked, from, to)) {
    const { attributes, next } = parseAttributeSections(file, part.start, part.end);
    const text = file.masked.slice(next, part.end);
    const match = PARAMETER.exec(text.trim());
    if (!match) continue;
    const name = match[3] as string;
    const leading = text.length - text.trimStart().length;
    const afterType = (match[1] as string).length + (match[2] as string).length;
    const nameOffset = next + leading + match[0].indexOf(name, afterType);
    parameters.push({
      name,
      type: (match[2] as string).trim(),
      attributes,
      modifiers: (match[1] as string).trim().split(/\s+/).filter(Boolean),
      hasDefault: match[4] !== undefined,
      offset: nameOffset,
    });
  }
  return parameters;
}

/** Split the inside of a `<…>` generic argument list on top-level commas. */
export function splitGenericArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[") depth += 1;
    else if (ch === ">" || ch === ")" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** The member names of an enum declaration, in source order. */
export function enumMembers(decl: CSharpTypeDecl): string[] {
  if (!decl.body) return [];
  const members: string[] = [];
  for (const part of splitTopLevel(decl.file.masked, decl.body.start, decl.body.end)) {
    const { next } = parseAttributeSections(decl.file, part.start, part.end);
    const match = /^\s*([A-Za-z_]\w*)/.exec(decl.file.masked.slice(next, part.end));
    if (match) members.push(match[1] as string);
  }
  return members;
}
