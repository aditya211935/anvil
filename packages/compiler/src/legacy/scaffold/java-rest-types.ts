import type { JavaSourceFile, JavaTypeDeclaration } from "./java-rest-source.js";
import type { ScaffoldSchema } from "./model.js";

/**
 * Project declared Java types onto the scaffold schema subset. Every schema
 * records the declared type text verbatim as `sourceType`; the JSON type is
 * taken from the Java language and standard library definitions only. An
 * enum or a plain data class declared in the same source set is projected
 * from its own declaration; any other type is an open object. Nothing is
 * loaded, and no property is invented.
 */

export interface TypeContext {
  /** Simple name → constants; `null` when two declarations share the name. */
  enums: ReadonlyMap<string, string[] | null>;
  /** Simple name → declaration with plain fields; `null` when ambiguous. */
  shapes: ReadonlyMap<string, JavaTypeDeclaration | null>;
}

interface TypeExpression {
  raw: string;
  /** Simple name: `java.util.List` → `List`; `?` for a wildcard. */
  name: string;
  arguments: TypeExpression[];
  /** Array depth; `T...` counts as one. */
  arrays: number;
}

const MAX_PROJECTION_DEPTH = 3;

const ROUTE_ANNOTATIONS = new Set([
  "Path",
  "RestController",
  "Controller",
  "RequestMapping",
  "ApplicationPath",
]);

export function buildTypeContext(files: readonly JavaSourceFile[]): TypeContext {
  const enums = new Map<string, string[] | null>();
  const shapes = new Map<string, JavaTypeDeclaration | null>();
  for (const file of files) {
    for (const type of file.types) {
      if (type.kind === "enum") {
        enums.set(type.name, enums.has(type.name) ? null : type.enumConstants);
        if (shapes.has(type.name)) shapes.set(type.name, null);
        continue;
      }
      if (enums.has(type.name)) enums.set(type.name, null);
      if (!isPlainShape(type)) {
        if (shapes.has(type.name)) shapes.set(type.name, null);
        continue;
      }
      shapes.set(type.name, shapes.has(type.name) ? null : type);
    }
  }
  return { enums, shapes };
}

function isPlainShape(type: JavaTypeDeclaration): boolean {
  if (type.kind !== "class" && type.kind !== "record") return false;
  if (type.annotations.some((annotation) => ROUTE_ANNOTATIONS.has(annotation.simpleName))) {
    return false;
  }
  return type.fields.some((field) => !field.isStatic);
}

/** `undefined` for `void`: the handler declares no payload. */
export function schemaForJavaType(type: string, context: TypeContext): ScaffoldSchema | undefined {
  return schemaFor(parseType(type), context, 0, new Set());
}

export function isOptionalType(type: string): boolean {
  return parseType(type).name === "Optional";
}

export function isMapLikeType(type: string): boolean {
  return MAP_TYPES.has(parseType(type).name);
}

const INT32 = new Set(["int", "Integer", "short", "Short", "byte", "Byte", "AtomicInteger"]);
const INT64 = new Set(["long", "Long", "AtomicLong"]);
const STRINGS = new Set(["String", "CharSequence", "char", "Character", "StringBuilder"]);
const DATE_TIMES = new Set([
  "Date",
  "LocalDateTime",
  "Instant",
  "ZonedDateTime",
  "OffsetDateTime",
  "Timestamp",
  "Calendar",
]);
const PLAIN_STRINGS = new Set([
  "LocalTime",
  "OffsetTime",
  "Duration",
  "Period",
  "Year",
  "YearMonth",
]);
const BINARIES = new Set([
  "InputStream",
  "File",
  "Path",
  "MultipartFile",
  "StreamingOutput",
  "Resource",
  "ByteBuffer",
]);
const COLLECTIONS = new Set([
  "List",
  "Set",
  "Collection",
  "Iterable",
  "Iterator",
  "ArrayList",
  "LinkedList",
  "HashSet",
  "LinkedHashSet",
  "TreeSet",
  "SortedSet",
  "Stream",
  "Flux",
]);
const MAP_TYPES = new Set([
  "Map",
  "HashMap",
  "TreeMap",
  "LinkedHashMap",
  "SortedMap",
  "MultiValueMap",
  "Properties",
  "JsonNode",
  "ObjectNode",
]);
const WRAPPERS = new Set([
  "Optional",
  "ResponseEntity",
  "HttpEntity",
  "Mono",
  "CompletableFuture",
  "CompletionStage",
  "Future",
  "Callable",
  "DeferredResult",
  "ListenableFuture",
]);

function schemaFor(
  type: TypeExpression,
  context: TypeContext,
  depth: number,
  visiting: ReadonlySet<string>,
): ScaffoldSchema | undefined {
  const sourceType = type.raw;
  if (type.arrays > 0) {
    if (type.arrays === 1 && (type.name === "byte" || type.name === "Byte")) {
      return { type: "string", format: "byte", sourceType };
    }
    const element = { ...type, arrays: type.arrays - 1, raw: elementRaw(type.raw) };
    return { type: "array", items: itemsOf(element, context, depth, visiting), sourceType };
  }
  const { name } = type;
  if (name === "void" || name === "Void") return undefined;
  if (STRINGS.has(name)) return { type: "string", sourceType };
  if (INT32.has(name)) return { type: "integer", format: "int32", sourceType };
  if (INT64.has(name)) return { type: "integer", format: "int64", sourceType };
  if (name === "BigInteger") return { type: "integer", sourceType };
  if (name === "float" || name === "Float") return { type: "number", format: "float", sourceType };
  if (name === "double" || name === "Double") {
    return { type: "number", format: "double", sourceType };
  }
  if (name === "BigDecimal" || name === "Number") return { type: "number", sourceType };
  if (name === "boolean" || name === "Boolean" || name === "AtomicBoolean") {
    return { type: "boolean", sourceType };
  }
  if (name === "UUID") return { type: "string", format: "uuid", sourceType };
  if (name === "LocalDate") return { type: "string", format: "date", sourceType };
  if (DATE_TIMES.has(name)) return { type: "string", format: "date-time", sourceType };
  if (PLAIN_STRINGS.has(name)) return { type: "string", sourceType };
  if (name === "URI" || name === "URL") return { type: "string", format: "uri", sourceType };
  if (BINARIES.has(name)) return { type: "string", format: "binary", sourceType };
  if (COLLECTIONS.has(name)) {
    const element = type.arguments[0];
    return {
      type: "array",
      items: element ? itemsOf(element, context, depth, visiting) : { type: "object" },
      sourceType,
    };
  }
  if (WRAPPERS.has(name)) {
    const inner = type.arguments[0];
    if (!inner || inner.name === "?") return { type: "object", sourceType };
    const unwrapped = schemaFor(inner, context, depth, visiting);
    return unwrapped ? { ...unwrapped, sourceType } : undefined;
  }
  if (MAP_TYPES.has(name) || name === "Object" || name === "?" || name === "Response") {
    return { type: "object", sourceType };
  }
  const constants = context.enums.get(name);
  if (constants && constants.length > 0) {
    return { type: "string", enum: [...constants], sourceType };
  }
  const shape = context.shapes.get(name);
  if (shape && depth < MAX_PROJECTION_DEPTH && !visiting.has(name)) {
    const nested = new Set(visiting);
    nested.add(name);
    const properties: Record<string, ScaffoldSchema> = {};
    for (const field of shape.fields) {
      if (field.isStatic || properties[field.name]) continue;
      const projected = schemaFor(parseType(field.type), context, depth + 1, nested);
      if (projected) properties[field.name] = projected;
    }
    return { type: "object", properties, sourceType };
  }
  return { type: "object", sourceType };
}

function itemsOf(
  element: TypeExpression,
  context: TypeContext,
  depth: number,
  visiting: ReadonlySet<string>,
): ScaffoldSchema {
  return (
    schemaFor(element, context, depth, visiting) ?? { type: "object", sourceType: element.raw }
  );
}

function elementRaw(raw: string): string {
  if (raw.endsWith("...")) return raw.slice(0, -3).trim();
  if (raw.endsWith("[]")) return raw.slice(0, -2).trim();
  return raw;
}

/** Read `Outer<Inner, ...>[]` into its parts; never resolves a name. */
function parseType(raw: string): TypeExpression {
  let text = raw.trim();
  let arrays = 0;
  if (text.endsWith("...")) {
    arrays += 1;
    text = text.slice(0, -3).trim();
  }
  while (text.endsWith("[]")) {
    arrays += 1;
    text = text.slice(0, -2).trim();
  }
  const open = text.indexOf("<");
  const head = (open >= 0 ? text.slice(0, open) : text).trim();
  const bounded = /^\?\s*(?:extends|super)\s+(.+)$/u.exec(head);
  if (bounded) return parseType(bounded[1] as string);
  const name = head.split(".").at(-1) ?? head;
  const argumentsText = open >= 0 && text.endsWith(">") ? text.slice(open + 1, -1) : "";
  const typeArguments = argumentsText ? splitArguments(argumentsText).map(parseType) : [];
  return { raw, name: name || "?", arguments: typeArguments, arrays };
}

function splitArguments(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "<") depth += 1;
    else if (char === ">") depth -= 1;
    else if (char === "," && depth === 0) {
      out.push(text.slice(start, index));
      start = index + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((piece) => piece.trim()).filter((piece) => piece !== "");
}
