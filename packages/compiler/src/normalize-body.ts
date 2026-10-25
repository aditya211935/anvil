import {
  agentPropKey,
  type BodyFieldEncoding,
  bodyEncodingFor,
  type JsonSchema,
  type Param,
  ParamStyle,
  type RequestBody,
  snakeCase,
} from "@anvil/air";
import { DEFAULT_SCHEMA_BOUNDS, materializeWithin, type SchemaBounds } from "./schema-bounds.js";

const SCALAR_TYPES = new Set(["string", "integer", "number", "boolean"]);

/** A body field is flag-projectable when it is a scalar (or an enum of scalars). */
function isScalarField(schema: JsonSchema): boolean {
  if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) {
    return false;
  }
  if (Array.isArray(schema.enum)) return true;
  if (schema.const !== undefined) return true;
  return typeof schema.type === "string" && SCALAR_TYPES.has(schema.type);
}

/**
 * Build the preserved request body plus its surface projection (spec: "preserve
 * the body as a body, derive the CLI projection separately"). The body schema is
 * kept verbatim; a flat object of scalars is additionally projected into
 * per-field flags, while anything richer (nesting, arrays, unions) is surfaced
 * whole so nothing is lost.
 */
/**
 * The OpenAPI media type object's `encoding` map, as a source hands it over:
 * one entry per top-level body property, carrying `style`/`explode` (and a
 * part `contentType` this compiler does not yet read).
 */
export type RawBodyEncoding = Record<string, { style?: unknown; explode?: unknown }>;

/**
 * Carry the declared per-field encodings into AIR, the way `toParam` carries a
 * parameter's: only what the source declared, only a style OpenAPI defines,
 * and nothing at all when nothing was declared — so a document without an
 * `encoding` map hashes exactly as it did before the field existed.
 */
function bodyEncodingOf(raw: RawBodyEncoding | undefined): RequestBody["encoding"] {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, BodyFieldEncoding> = {};
  for (const [field, declared] of Object.entries(raw)) {
    if (!declared || typeof declared !== "object") continue;
    const style = ParamStyle.safeParse(declared.style).data;
    const entry: BodyFieldEncoding = {
      ...(style ? { style } : {}),
      ...(typeof declared.explode === "boolean" ? { explode: declared.explode } : {}),
    };
    if (Object.keys(entry).length > 0) out[field] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function buildRequestBody(
  content: Record<string, { schema?: JsonSchema; encoding?: RawBodyEncoding }> | undefined,
  required: boolean,
  namedSchemas: Record<string, unknown>,
  params: readonly Param[],
  bounds: SchemaBounds = DEFAULT_SCHEMA_BOUNDS,
): RequestBody | undefined {
  if (!content) return undefined;
  // One body, one content type. JSON first because it is the wire the whole
  // toolchain speaks best; then any other type the runtime can encode; then the
  // source's first declaration, kept verbatim so the compile diagnostic and the
  // runtime refusal both name the type the source actually declared.
  const declared = Object.keys(content);
  const contentType =
    (content["application/json"] ? "application/json" : undefined) ??
    declared.find((type) => bodyEncodingFor(type) !== undefined) ??
    declared[0] ??
    "application/json";
  const rawSchema = content[contentType]?.schema;
  if (!rawSchema) return undefined;
  // The media type's `encoding` says how each field goes on the wire. It is
  // meaningful for a form (and multipart) body, where the runtime reads it; a
  // JSON body has no per-field wire encoding, so none is carried for one.
  const encoding =
    bodyEncodingFor(contentType) === "json"
      ? undefined
      : bodyEncodingOf(content[contentType]?.encoding);
  // `bundleDocument` (decycle.ts) left named-schema references as `$ref`
  // pointers so the whole spec's schema graph is only ever walked once; this
  // is the one place a body needs its own fields directly inspectable
  // (`.properties`, `.type`), so resolve back to a small, self-contained
  // schema scoped to just this operation before doing anything else with it.
  const schema = materializeWithin(rawSchema, namedSchemas, bounds).schema as JsonSchema;

  const props = schema.properties as Record<string, JsonSchema> | undefined;
  const requiredList = (schema.required as string[] | undefined) ?? [];
  const noCompositor =
    !Array.isArray(schema.oneOf) && !Array.isArray(schema.anyOf) && !Array.isArray(schema.allOf);
  const flat =
    schema.type === "object" &&
    props !== undefined &&
    noCompositor &&
    Object.values(props).every(isScalarField);

  // Flattening is only a convenience projection. A path/query/header input
  // and a body field may legitimately share a wire name (e.g. an addressed
  // org unit and its new orgUnitPath). Preserve their independent values by
  // keeping the body envelope whenever flattening would merge agent inputs.
  const paramKeys = new Set(params.map(agentPropKey));
  const fieldKeys = Object.keys(props ?? {}).map(snakeCase);
  const unambiguous =
    new Set(fieldKeys).size === fieldKeys.length && fieldKeys.every((key) => !paramKeys.has(key));
  if (flat && props && unambiguous) {
    return {
      contentType,
      required,
      schema,
      projection: "fields",
      fields: Object.entries(props).map(([name, propSchema]) => ({
        name,
        required: requiredList.includes(name),
        schema: propSchema,
        description: propSchema.description as string | undefined,
      })),
      ...(encoding ? { encoding } : {}),
    };
  }
  return {
    contentType,
    required,
    schema,
    projection: "whole",
    fields: [],
    ...(encoding ? { encoding } : {}),
  };
}
