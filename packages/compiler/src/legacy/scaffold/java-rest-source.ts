import {
  type Annotation,
  lineAt,
  maskCommentsAndLiterals,
  scanAnnotations,
} from "../collectors/java-ee/source.js";
import { type AnnotationArguments, parseAnnotationArguments } from "./java-rest-annotations.js";

/**
 * A bounded structural reading of one Java compilation unit: the types it
 * declares, the annotations attached to each type, member and parameter, and
 * the declared type text of every field, parameter and return. It is read
 * from the text with comments, literals and annotation bodies blanked out, so
 * braces and parentheses can be matched without a Java grammar. Nothing is
 * resolved: a type name is the identifier as written, never a loaded class.
 */

export interface JavaAnnotationUse extends Annotation {
  line: number;
  args: AnnotationArguments;
  /** `@Name(` opened arguments that never closed; the use keeps its name only. */
  unparseable: boolean;
}

export interface JavaParameter {
  annotations: JavaAnnotationUse[];
  /** Declared type text, whitespace-normalized, annotations removed. */
  type: string;
  name: string;
  line: number;
}

export interface JavaMethod {
  annotations: JavaAnnotationUse[];
  returnType: string;
  name: string;
  parameters: JavaParameter[];
  line: number;
}

export interface JavaField {
  annotations: JavaAnnotationUse[];
  type: string;
  name: string;
  line: number;
  isStatic: boolean;
}

export interface JavaTypeDeclaration {
  kind: "class" | "interface" | "enum" | "record";
  name: string;
  qualifiedName: string;
  packageName?: string;
  annotations: JavaAnnotationUse[];
  extendsNames: string[];
  implementsNames: string[];
  methods: JavaMethod[];
  fields: JavaField[];
  enumConstants: string[];
  line: number;
  path: string;
}

export interface JavaSourceFile {
  path: string;
  packageName?: string;
  types: JavaTypeDeclaration[];
  /** Every annotation use in the file, for diagnostics about unparseable ones. */
  annotations: JavaAnnotationUse[];
}

interface TypeRange {
  kind: JavaTypeDeclaration["kind"];
  name: string;
  keywordIndex: number;
  headerStart: number;
  open: number;
  close: number;
}

const MODIFIER =
  /\b(?:public|private|protected|static|final|abstract|synchronized|native|transient|volatile|strictfp|default|sealed|non-sealed)\b/gu;
const TYPE_KEYWORD = /\b(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/gu;

export function readJavaSource(path: string, text: string): JavaSourceFile {
  const masked = maskCommentsAndLiterals(text);
  const annotations = scanAnnotations(text).map((annotation) =>
    annotationUse(text, masked, annotation),
  );
  const structural = blankAnnotations(masked, annotations);
  const packageName = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/u.exec(
    structural,
  )?.[1];
  const ranges = typeRanges(structural);
  const types = ranges.map((range) =>
    buildType(path, text, structural, annotations, range, packageName),
  );
  return { path, ...(packageName ? { packageName } : {}), types, annotations };
}

function annotationUse(text: string, masked: string, annotation: Annotation): JavaAnnotationUse {
  return {
    ...annotation,
    line: lineAt(text, annotation.start),
    args: parseAnnotationArguments(annotation.body),
    unparseable: annotation.body === undefined && masked[annotation.end] === "(",
  };
}

/** Blank every annotation use so its parentheses never confuse member scanning. */
function blankAnnotations(masked: string, annotations: readonly JavaAnnotationUse[]): string {
  const chars = masked.split("");
  for (const annotation of annotations) {
    for (let index = annotation.start; index < annotation.end; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
  }
  return chars.join("");
}

function typeRanges(structural: string): TypeRange[] {
  const ranges: TypeRange[] = [];
  for (const match of structural.matchAll(TYPE_KEYWORD)) {
    const keywordIndex = match.index;
    if (structural.slice(0, keywordIndex).trimEnd().endsWith(".")) continue;
    const headerStart = keywordIndex + match[0].length;
    let open = -1;
    let depth = 0;
    for (let index = headerStart; index < structural.length; index += 1) {
      const char = structural[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0) {
        if (char === "{") {
          open = index;
          break;
        }
        if (char === ";" || char === "=") break;
      }
    }
    if (open < 0) continue;
    const close = matchBrace(structural, open, structural.length);
    ranges.push({
      kind: match[1] as TypeRange["kind"],
      name: match[2] as string,
      keywordIndex,
      headerStart,
      open,
      close: close < 0 ? structural.length : close,
    });
  }
  return ranges;
}

function buildType(
  path: string,
  text: string,
  structural: string,
  annotations: readonly JavaAnnotationUse[],
  range: TypeRange,
  packageName: string | undefined,
): JavaTypeDeclaration {
  let header = structural.slice(range.headerStart, range.open);
  if (header.trimStart().startsWith("<")) {
    const end = matchAngle(header, header.indexOf("<"));
    header = end < 0 ? "" : header.slice(end + 1);
  }
  const extendsClause = /\bextends\s+([\s\S]+?)(?=\bimplements\b|\bpermits\b|$)/u.exec(header);
  const implementsClause = /\bimplements\s+([\s\S]+?)(?=\bpermits\b|$)/u.exec(header);
  const fields: JavaField[] = [];
  if (range.kind === "record") {
    const open = header.indexOf("(");
    const close = open >= 0 ? matchParen(header, open) : -1;
    if (open >= 0 && close > open) {
      const offset = range.headerStart + open + 1;
      for (const piece of splitTopLevel(header.slice(open + 1, close), offset)) {
        const component = parseParameter(text, piece, annotations);
        if (component) fields.push({ ...component, isStatic: false });
      }
    }
  }
  const members = scanMembers(
    text,
    structural,
    annotations,
    range.open + 1,
    range.close,
    range.kind === "enum",
  );
  const declaration: JavaTypeDeclaration = {
    kind: range.kind,
    name: range.name,
    qualifiedName: packageName ? `${packageName}.${range.name}` : range.name,
    annotations: attachedAnnotations(structural, annotations, range.keywordIndex),
    extendsNames: typeNames(extendsClause?.[1] ?? ""),
    implementsNames: typeNames(implementsClause?.[1] ?? ""),
    methods: members.methods,
    fields: [...fields, ...members.fields],
    enumConstants: members.enumConstants,
    line: lineAt(text, range.keywordIndex),
    path,
  };
  if (packageName) declaration.packageName = packageName;
  return declaration;
}

function typeNames(clause: string): string[] {
  return splitTopLevel(clause, 0)
    .map((piece) => piece.text.replace(/<[\s\S]*$/u, "").trim())
    .filter((name) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(name));
}

/** Annotations separated from a declaration keyword only by whitespace and modifiers. */
function attachedAnnotations(
  structural: string,
  annotations: readonly JavaAnnotationUse[],
  declarationIndex: number,
): JavaAnnotationUse[] {
  const attached: JavaAnnotationUse[] = [];
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const candidate = annotations[index];
    if (!candidate || candidate.end > declarationIndex) continue;
    if (!onlyModifiers(structural.slice(candidate.end, declarationIndex))) break;
    attached.unshift(candidate);
  }
  return attached;
}

function onlyModifiers(gap: string): boolean {
  return gap.replace(MODIFIER, " ").trim() === "";
}

function scanMembers(
  text: string,
  structural: string,
  annotations: readonly JavaAnnotationUse[],
  bodyStart: number,
  bodyEnd: number,
  isEnum: boolean,
): { methods: JavaMethod[]; fields: JavaField[]; enumConstants: string[] } {
  const methods: JavaMethod[] = [];
  const fields: JavaField[] = [];
  let enumConstants: string[] = [];
  let index = bodyStart;
  if (isEnum) {
    const constantsEnd = enumConstantsEnd(structural, bodyStart, bodyEnd);
    enumConstants = splitTopLevel(structural.slice(bodyStart, constantsEnd), bodyStart)
      .map((piece) => /^\s*([A-Za-z_$][\w$]*)/u.exec(piece.text)?.[1])
      .filter((name): name is string => name !== undefined);
    index = Math.min(constantsEnd + 1, bodyEnd);
  }
  let segmentStart = index;
  let parenDepth = 0;
  while (index < bodyEnd) {
    const char = structural[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && char === ";") {
      emitSegment(structural.slice(segmentStart, index), segmentStart);
      segmentStart = index + 1;
    } else if (parenDepth === 0 && char === "{") {
      const header = structural.slice(segmentStart, index);
      const close = matchBrace(structural, index, bodyEnd);
      const blockEnd = close < 0 ? bodyEnd : close;
      if (/\bclass\s|\binterface\s|\benum\s|\brecord\s/u.test(header) || header.includes("=")) {
        // A nested type is read as its own declaration; a field initializer
        // block belongs to the field whose `;` follows.
        if (header.includes("=")) {
          index = blockEnd + 1;
          continue;
        }
        segmentStart = blockEnd + 1;
      } else if (header.replace(/\bstatic\b/u, "").trim() === "") {
        segmentStart = blockEnd + 1;
      } else {
        emitSegment(header, segmentStart);
        segmentStart = blockEnd + 1;
      }
      index = blockEnd + 1;
      continue;
    }
    index += 1;
  }
  return { methods, fields, enumConstants };

  function emitSegment(header: string, start: number): void {
    if (header.trim() === "") return;
    const equals = header.indexOf("=");
    const paren = header.indexOf("(");
    if (paren >= 0 && (equals < 0 || paren < equals)) {
      const method = parseMethod(text, header, start, annotations);
      if (method) methods.push(method);
      return;
    }
    fields.push(...parseField(text, header, start, annotations));
  }
}

function enumConstantsEnd(structural: string, bodyStart: number, bodyEnd: number): number {
  let depth = 0;
  for (let index = bodyStart; index < bodyEnd; index += 1) {
    const char = structural[index];
    if (char === "(" || char === "{") depth += 1;
    else if (char === ")" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === ";" && depth === 0) return index;
  }
  return bodyEnd;
}

function parseMethod(
  text: string,
  header: string,
  start: number,
  annotations: readonly JavaAnnotationUse[],
): JavaMethod | undefined {
  const open = header.indexOf("(");
  const nameMatch = /([A-Za-z_$][\w$]*)\s*$/u.exec(header.slice(0, open));
  if (!nameMatch) return undefined;
  const close = matchParen(header, open);
  if (close < 0) return undefined;
  const nameStart = nameMatch.index;
  let prefix = header.slice(0, nameStart).replace(MODIFIER, " ").trim();
  if (prefix.startsWith("<")) {
    const end = matchAngle(prefix, 0);
    prefix = end < 0 ? "" : prefix.slice(end + 1).trim();
  }
  if (prefix === "") return undefined; // a constructor declares no route or type
  const parameters = splitTopLevel(header.slice(open + 1, close), start + open + 1)
    .map((piece) => parseParameter(text, piece, annotations))
    .filter((parameter): parameter is JavaParameter => parameter !== undefined);
  return {
    annotations: annotations.filter(
      (annotation) => annotation.start >= start && annotation.end <= start + nameStart,
    ),
    returnType: normalizeType(prefix),
    name: nameMatch[1] as string,
    parameters,
    line: lineAt(text, start + nameStart),
  };
}

function parseField(
  text: string,
  header: string,
  start: number,
  annotations: readonly JavaAnnotationUse[],
): JavaField[] {
  const equals = header.indexOf("=");
  const declaration = equals >= 0 ? header.slice(0, equals) : header;
  if (declaration.includes("(")) return [];
  const isStatic = /\bstatic\b/u.test(declaration);
  const owned = annotations.filter(
    (annotation) => annotation.start >= start && annotation.end <= start + declaration.length,
  );
  const pieces = splitTopLevel(declaration.replace(MODIFIER, " "), start);
  const [first, ...rest] = pieces;
  if (!first) return [];
  const leading = parseParameter(text, first, annotations);
  if (!leading) return [];
  const fields: JavaField[] = [{ ...leading, annotations: owned, isStatic }];
  for (const piece of rest) {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*$/u.exec(piece.text)?.[1];
    if (!name) continue;
    fields.push({
      annotations: owned,
      type: leading.type,
      name,
      line: lineAt(text, piece.start),
      isStatic,
    });
  }
  return fields;
}

function parseParameter(
  text: string,
  piece: { text: string; start: number },
  annotations: readonly JavaAnnotationUse[],
): JavaParameter | undefined {
  const cleaned = piece.text.replace(/\bfinal\b/gu, " ");
  const match = /^\s*([\s\S]*?)\s*([A-Za-z_$][\w$]*)\s*((?:\[\s*\]\s*)*)$/u.exec(cleaned);
  const typeText = match?.[1]?.trim();
  if (!match || !typeText) return undefined;
  const name = match[2] as string;
  const trailingArrays = (match[3] ?? "").split("[").length - 1;
  const nameIndex = cleaned.lastIndexOf(name, cleaned.length - (match[3] ?? "").length);
  return {
    annotations: annotations.filter(
      (annotation) =>
        annotation.start >= piece.start && annotation.end <= piece.start + piece.text.length,
    ),
    type: normalizeType(typeText) + "[]".repeat(trailingArrays),
    name,
    line: lineAt(text, piece.start + Math.max(nameIndex, 0)),
  };
}

/** Collapse whitespace so `Map< String , Object >` and `Map<String, Object>` read alike. */
function normalizeType(type: string): string {
  return type
    .replace(/\s+/gu, " ")
    .replace(/\s*([<>,[\].?])\s*/gu, "$1")
    .replace(/,/gu, ", ")
    .replace(/\?(extends|super)\b/gu, "? $1 ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Split at top-level commas; angle brackets, parentheses, brackets and braces nest. */
function splitTopLevel(text: string, offset: number): { text: string; start: number }[] {
  const pieces: { text: string; start: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "<" || char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ">" || char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
    } else if (char === "," && depth === 0) {
      pieces.push({ text: text.slice(start, index), start: offset + start });
      start = index + 1;
    }
  }
  pieces.push({ text: text.slice(start), start: offset + start });
  return pieces.filter((piece) => piece.text.trim() !== "");
}

function matchBrace(structural: string, open: number, limit: number): number {
  let depth = 0;
  for (let index = open; index < limit; index += 1) {
    const char = structural[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchParen(header: string, open: number): number {
  let depth = 0;
  for (let index = open; index < header.length; index += 1) {
    const char = header[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function matchAngle(header: string, open: number): number {
  let depth = 0;
  for (let index = open; index < header.length; index += 1) {
    const char = header[index];
    if (char === "<") depth += 1;
    else if (char === ">") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}
