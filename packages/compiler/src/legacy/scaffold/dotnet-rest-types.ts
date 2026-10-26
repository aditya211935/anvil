/**
 * C# declared types → the scaffold's JSON-Schema subset. Only what the source
 * states is projected: a BCL primitive maps to its JSON type, an enum or DTO
 * declared in the same source set contributes its member or property names,
 * and anything else is an open object that records the source type verbatim.
 */

import {
  type CSharpTypeDecl,
  classMembers,
  enumMembers,
  lastSegment,
  splitGenericArguments,
} from "./csharp-decls.js";
import type { ScaffoldSchema } from "./model.js";

export interface DotnetTypeIndex {
  enums: Map<string, { decl: CSharpTypeDecl; members: string[] }>;
  dtos: Map<string, CSharpTypeDecl>;
}

export interface ParsedCSharpType {
  /** Last segment of the type name, generic arguments removed (`List`). */
  name: string;
  arguments: string[];
  nullable: boolean;
  /** Array ranks declared after the name (`int[]` → 1, `int[][]` → 2). */
  arrayRank: number;
}

const MAX_SCHEMA_DEPTH = 4;

const PRIMITIVES: Record<string, ScaffoldSchema> = {
  string: { type: "string" },
  String: { type: "string" },
  char: { type: "string" },
  Char: { type: "string" },
  int: { type: "integer", format: "int32" },
  Int32: { type: "integer", format: "int32" },
  uint: { type: "integer", format: "int64" },
  UInt32: { type: "integer", format: "int64" },
  long: { type: "integer", format: "int64" },
  Int64: { type: "integer", format: "int64" },
  ulong: { type: "integer" },
  UInt64: { type: "integer" },
  short: { type: "integer", format: "int32" },
  Int16: { type: "integer", format: "int32" },
  ushort: { type: "integer", format: "int32" },
  UInt16: { type: "integer", format: "int32" },
  byte: { type: "integer", format: "int32" },
  Byte: { type: "integer", format: "int32" },
  sbyte: { type: "integer", format: "int32" },
  SByte: { type: "integer", format: "int32" },
  float: { type: "number", format: "float" },
  Single: { type: "number", format: "float" },
  double: { type: "number", format: "double" },
  Double: { type: "number", format: "double" },
  decimal: { type: "number" },
  Decimal: { type: "number" },
  bool: { type: "boolean" },
  Boolean: { type: "boolean" },
  Guid: { type: "string", format: "uuid" },
  DateTime: { type: "string", format: "date-time" },
  DateTimeOffset: { type: "string", format: "date-time" },
  DateOnly: { type: "string", format: "date" },
  TimeOnly: { type: "string", format: "time" },
  TimeSpan: { type: "string" },
  Uri: { type: "string", format: "uri" },
};

const COLLECTIONS = new Set([
  "IEnumerable",
  "ICollection",
  "IList",
  "List",
  "IReadOnlyList",
  "IReadOnlyCollection",
  "ISet",
  "HashSet",
  "Collection",
  "IQueryable",
  "IAsyncEnumerable",
  "ImmutableArray",
  "ImmutableList",
]);

/** Wrappers whose single type argument is the declared payload. */
const TRANSPARENT = new Set(["Task", "ValueTask", "ActionResult", "Nullable", "Ok"]);

/** Return types that declare no payload shape at all. */
const SHAPELESS = new Set([
  "void",
  "Task",
  "ValueTask",
  "IActionResult",
  "ActionResult",
  "IResult",
  "IHttpActionResult",
  "HttpResponseMessage",
  "IConvertToActionResult",
]);

export function buildTypeIndex(declarations: readonly CSharpTypeDecl[]): DotnetTypeIndex {
  const index: DotnetTypeIndex = { enums: new Map(), dtos: new Map() };
  for (const decl of declarations) {
    if (decl.kind === "enum") {
      if (!index.enums.has(decl.name)) {
        index.enums.set(decl.name, { decl, members: enumMembers(decl) });
      }
    } else if (decl.kind === "class" || decl.kind === "record" || decl.kind === "struct") {
      if (!index.dtos.has(decl.name) && !decl.modifiers.includes("static")) {
        index.dtos.set(decl.name, decl);
      }
    }
  }
  return index;
}

export function parseCSharpType(type: string): ParsedCSharpType {
  let text = type
    .trim()
    .replace(/^global::/, "")
    .replace(/^(?:ref|out|in)\s+/, "");
  let arrayRank = 0;
  let nullable = false;
  for (;;) {
    if (text.endsWith("?")) {
      nullable = true;
      text = text.slice(0, -1).trimEnd();
      continue;
    }
    const array = /\[\s*,*\s*\]$/.exec(text);
    if (array) {
      arrayRank += 1;
      text = text.slice(0, array.index).trimEnd();
      continue;
    }
    break;
  }
  const open = text.indexOf("<");
  const name = lastSegment(open === -1 ? text : text.slice(0, open));
  const args =
    open === -1 ? [] : splitGenericArguments(text.slice(open + 1, text.lastIndexOf(">")));
  return { name, arguments: args, nullable, arrayRank };
}

/**
 * Unwrap `Task<T>`, `ActionResult<T>` and `ValueTask<T>` to the declared `T`;
 * `undefined` when the return type declares no shape (`IActionResult`, `void`).
 */
export function declaredReturnType(type: string): string | undefined {
  const parsed = parseCSharpType(type);
  if (parsed.arrayRank === 0 && TRANSPARENT.has(parsed.name) && parsed.arguments.length === 1) {
    return declaredReturnType(parsed.arguments[0] as string);
  }
  if (parsed.arrayRank === 0 && SHAPELESS.has(parsed.name) && parsed.arguments.length === 0) {
    return undefined;
  }
  return type.trim();
}

/** A type model binding treats as a single value (route, query or header). */
export function isSimpleType(type: string, index: DotnetTypeIndex): boolean {
  const parsed = parseCSharpType(type);
  if (parsed.arrayRank > 0) return false;
  if (parsed.name === "Nullable" && parsed.arguments.length === 1) {
    return isSimpleType(parsed.arguments[0] as string, index);
  }
  if (parsed.arguments.length > 0) return false;
  return parsed.name in PRIMITIVES || index.enums.has(parsed.name);
}

/** An array or collection of simple types (bound from the query string by convention). */
export function isSimpleCollection(type: string, index: DotnetTypeIndex): boolean {
  const parsed = parseCSharpType(type);
  if (parsed.arrayRank === 1) {
    return isSimpleType(type.trim().replace(/\[\s*,*\s*\]\??$/, ""), index);
  }
  return (
    parsed.arrayRank === 0 &&
    COLLECTIONS.has(parsed.name) &&
    parsed.arguments.length === 1 &&
    isSimpleType(parsed.arguments[0] as string, index)
  );
}

/** Project a declared C# type onto the scaffold schema subset. */
export function schemaForCSharpType(
  type: string,
  index: DotnetTypeIndex,
  depth = 0,
  visiting: ReadonlySet<string> = new Set(),
): ScaffoldSchema {
  const sourceType = type.trim();
  const parsed = parseCSharpType(sourceType);
  if (parsed.arrayRank > 0) {
    const element = sourceType.replace(/\??$/, "").replace(/\[\s*,*\s*\]\??$/, "");
    if (parsed.arrayRank === 1 && /^(?:byte|System\.Byte|Byte)$/.test(element.trim())) {
      return { type: "string", format: "byte", sourceType };
    }
    return { type: "array", items: elementSchema(element, index, depth, visiting), sourceType };
  }
  if (parsed.name === "Nullable" && parsed.arguments.length === 1) {
    return {
      ...schemaForCSharpType(parsed.arguments[0] as string, index, depth, visiting),
      sourceType,
    };
  }
  if (TRANSPARENT.has(parsed.name) && parsed.arguments.length === 1) {
    return {
      ...schemaForCSharpType(parsed.arguments[0] as string, index, depth, visiting),
      sourceType,
    };
  }
  if (parsed.arguments.length === 0) {
    const primitive = PRIMITIVES[parsed.name];
    if (primitive) return { ...primitive, sourceType };
    const enumeration = index.enums.get(parsed.name);
    if (enumeration) {
      return {
        type: "string",
        ...(enumeration.members.length > 0 ? { enum: [...enumeration.members] } : {}),
        sourceType,
      };
    }
  }
  if (COLLECTIONS.has(parsed.name) && parsed.arguments.length === 1) {
    return {
      type: "array",
      items: elementSchema(parsed.arguments[0] as string, index, depth, visiting),
      sourceType,
    };
  }
  if (parsed.arguments.length === 0) {
    const dto = index.dtos.get(parsed.name);
    if (dto && depth < MAX_SCHEMA_DEPTH && !visiting.has(parsed.name)) {
      const projected = dtoSchema(dto, index, depth + 1, new Set([...visiting, parsed.name]));
      if (projected) return { ...projected, sourceType };
    }
  }
  return { type: "object", sourceType };
}

function elementSchema(
  element: string,
  index: DotnetTypeIndex,
  depth: number,
  visiting: ReadonlySet<string>,
): ScaffoldSchema {
  if (depth >= MAX_SCHEMA_DEPTH) return { type: "object", sourceType: element.trim() };
  return schemaForCSharpType(element, index, depth + 1, visiting);
}

function dtoSchema(
  decl: CSharpTypeDecl,
  index: DotnetTypeIndex,
  depth: number,
  visiting: ReadonlySet<string>,
): ScaffoldSchema | undefined {
  const properties: Record<string, ScaffoldSchema> = {};
  const required: string[] = [];
  for (const parameter of decl.primaryParameters ?? []) {
    properties[parameter.name] = schemaForCSharpType(parameter.type, index, depth, visiting);
  }
  const { properties: declared } = classMembers(decl);
  for (const property of declared) {
    if (!property.modifiers.includes("public") || property.modifiers.includes("static")) continue;
    if (property.attributes.some((attribute) => attribute.name === "JsonIgnore")) continue;
    const name =
      property.attributes
        .find(
          (attribute) => attribute.name === "JsonPropertyName" || attribute.name === "JsonProperty",
        )
        ?.positional.find((argument) => argument.kind === "string")?.value ?? property.name;
    properties[name] = schemaForCSharpType(property.type, index, depth, visiting);
    if (property.modifiers.includes("required")) required.push(name);
  }
  if (Object.keys(properties).length === 0) return undefined;
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}
