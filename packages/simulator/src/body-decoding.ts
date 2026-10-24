/**
 * Request body decoding for the simulator's HTTP server: the inverse of the
 * runtime's `body-encoding.ts`.
 *
 * The runtime puts a body on the wire in the content type the operation
 * declares: JSON, `application/x-www-form-urlencoded`, or real
 * `multipart/form-data` bytes. A server that JSON-parsed every body would
 * refuse the second and third before routing, so a contract the runtime and
 * the generated SDKs can call would be one the simulator cannot serve. The
 * route is chosen first; this module then reads the body the way that
 * operation declares it, and hands back the value the runtime was given: a
 * form's fields typed by their schema, a file part as the base64 string an
 * agent supplies.
 *
 * The decoding keys on the *declared* content type, not the request's header,
 * because the declaration is the contract. The header is read only for what
 * the declaration cannot carry: a multipart boundary.
 */
import {
  bodyEncodingFor,
  isBinaryFieldSchema,
  type JsonSchema,
  mediaTypeOf,
  type Operation,
} from "@anvil/air";

export type DecodedBody =
  | { ok: true; value: unknown }
  | { ok: false; status: number; message: string };

/** Coerce one wire string to the scalar type a schema declares; anything else stays text. */
function scalar(raw: string, type: unknown): unknown {
  if (type === "integer" || type === "number") {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (type === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}

function schemaType(schema: JsonSchema | undefined): unknown {
  const raw = schema?.type;
  return Array.isArray(raw) ? raw.find((t) => t !== "null") : raw;
}

/**
 * Coerce the string values a query, header, cookie or form field carried to
 * what its schema declares. With `splitCommas`, one value of an array
 * parameter is read in the `form, explode: false` style (`a,b,c`); a form
 * body repeats its key instead, so it never splits.
 */
export function coerceWireValues(
  schema: JsonSchema | undefined,
  values: string[],
  splitCommas: boolean,
): unknown {
  if (schemaType(schema) === "array") {
    const items = (schema?.items ?? {}) as JsonSchema;
    const parts = splitCommas && values.length === 1 ? (values[0] ?? "").split(",") : values;
    return parts.map((v) => scalar(v, schemaType(items)));
  }
  return scalar(values[values.length - 1] ?? "", schemaType(schema));
}

/** The body-field schema, from the preserved body schema first, then the projection. */
function fieldSchema(op: Operation, name: string): JsonSchema | undefined {
  const body = op.input.body;
  if (!body) return undefined;
  const props = body.schema.properties as Record<string, JsonSchema> | undefined;
  return props?.[name] ?? body.fields.find((f) => f.name === name)?.schema;
}

function parseJson(raw: Buffer): DecodedBody {
  try {
    return { ok: true, value: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { ok: false, status: 400, message: "Request body is not valid JSON." };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The bracket segments of a deepObject key's tail: `[address][0]` → `["address", "0"]`. */
function bracketSegments(tail: string): string[] {
  const out: string[] = [];
  const bracket = /\[([^\]]*)\]/g;
  for (let m = bracket.exec(tail); m !== null; m = bracket.exec(tail)) out.push(m[1] ?? "");
  return out;
}

/** The schema one bracket segment down: an array's items, an object's property or its map value. */
function childSchema(schema: JsonSchema | undefined, segment: string): JsonSchema | undefined {
  if (!schema) return undefined;
  const alternatives = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(alternatives) && schema.type === undefined && !isRecord(schema.properties)) {
    // Stripe's `created` is `anyOf [range object, integer]`; a bracketed key
    // can only have come from the structured branch.
    const structured = alternatives.find(
      (a) => a.type === "object" || a.type === "array" || isRecord(a.properties) || a.items,
    );
    return childSchema(structured, segment);
  }
  if (schemaType(schema) === "array" || schema.items !== undefined) {
    return (schema.items as JsonSchema | undefined) ?? undefined;
  }
  const props = schema.properties as Record<string, JsonSchema> | undefined;
  if (props?.[segment]) return props[segment];
  const extra = schema.additionalProperties;
  return isRecord(extra) ? (extra as JsonSchema) : undefined;
}

/**
 * The scalar type a bare (unbracketed) value of this schema has: its own type,
 * or the scalar branch of a union such as Stripe's `created: anyOf [range
 * object, integer]`, whose `created=7` is the integer and not the text "7".
 */
function scalarBranchType(schema: JsonSchema | undefined): unknown {
  const own = schemaType(schema);
  if (own !== undefined) return own;
  const alternatives = (schema?.anyOf ?? schema?.oneOf) as JsonSchema[] | undefined;
  if (!Array.isArray(alternatives)) return undefined;
  const scalarTypes = new Set(["integer", "number", "boolean", "string"]);
  return alternatives.map(schemaType).find((t) => typeof t === "string" && scalarTypes.has(t));
}

function assignBracketed(
  current: unknown,
  segments: readonly string[],
  text: string,
  schema: JsonSchema | undefined,
): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return scalar(text, schemaType(schema));
  const child = childSchema(schema, head);
  if (/^\d+$/.test(head)) {
    const list: unknown[] = Array.isArray(current) ? current : [];
    list[Number(head)] = assignBracketed(list[Number(head)], rest, text, child);
    return list;
  }
  const record: Record<string, unknown> = isRecord(current) ? current : {};
  record[head] = assignBracketed(record[head], rest, text, child);
  return record;
}

/**
 * The inverse of the runtime's `deepObject` encoding: every wire pair under
 * `root` (`root`, `root[a]`, `root[items][0][price]`) folded back into the one
 * value the caller bound — an object by key, an array by index — with each
 * leaf typed by its schema path. Read only for a parameter or body field the
 * contract declares `deepObject`; an undeclared bracketed key stays a key.
 */
export function decodeDeepObject(
  root: string,
  schema: JsonSchema | undefined,
  pairs: Iterable<[string, string]>,
): unknown {
  let value: unknown;
  for (const [key, text] of pairs) {
    if (key === root) {
      value = scalar(text, scalarBranchType(schema));
    } else if (key.startsWith(`${root}[`)) {
      value = assignBracketed(value, bracketSegments(key.slice(root.length)), text, schema);
    }
  }
  return value;
}

function decodeForm(op: Operation, raw: Buffer): DecodedBody {
  const form = new URLSearchParams(raw.toString("utf8"));
  const out: Record<string, unknown> = {};
  const encodings = op.input.body?.encoding ?? {};
  const deep = new Set<string>();
  for (const name of new Set(form.keys())) {
    const bracket = name.indexOf("[");
    const root = bracket === -1 ? name : name.slice(0, bracket);
    // A field the contract declares `deepObject` arrives as bracketed keys
    // (`metadata[order]=123`), which fold back into the field; any other field
    // is read as the plain form it is.
    if (encodings[root]?.style === "deepObject") {
      deep.add(root);
      continue;
    }
    out[name] = coerceWireValues(fieldSchema(op, name), form.getAll(name), false);
  }
  for (const root of deep) {
    const value = decodeDeepObject(root, fieldSchema(op, root), form.entries());
    if (value !== undefined) out[root] = value;
  }
  return { ok: true, value: out };
}

/** A header parameter's value (`boundary=...`, `name="..."`), unquoted. */
function headerParam(header: string, param: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${param}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(
    header,
  );
  if (!match) return undefined;
  return match[1] ?? match[2];
}

interface Part {
  name: string;
  filename: string | undefined;
  contentType: string | undefined;
  bytes: Buffer;
}

/** RFC 7578 parts, read as bytes so a file part survives intact. */
function multipartParts(raw: Buffer, boundary: string): Part[] | undefined {
  const delimiter = Buffer.from(`--${boundary}`, "latin1");
  const between = Buffer.from(`\r\n--${boundary}`, "latin1");
  let pos = raw.indexOf(delimiter);
  if (pos === -1) return undefined;
  pos += delimiter.length;
  const parts: Part[] = [];
  for (;;) {
    // `--boundary--` closes the body.
    if (raw[pos] === 0x2d && raw[pos + 1] === 0x2d) return parts;
    if (raw[pos] === 0x0d && raw[pos + 1] === 0x0a) pos += 2;
    const end = raw.indexOf(between, pos);
    if (end === -1) return undefined;
    const part = raw.subarray(pos, end);
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd === -1) return undefined;
    const headers = new Map<string, string>();
    for (const line of part.subarray(0, headEnd).toString("utf8").split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1));
    }
    const disposition = headers.get("content-disposition") ?? "";
    const name = headerParam(disposition, "name");
    if (name === undefined) return undefined;
    // The runtime writes a `"` in a name as `%22` (RFC 7578 section 4.2).
    const unquote = (s: string) => s.replace(/%22/g, '"');
    const filename = headerParam(disposition, "filename");
    parts.push({
      name: unquote(name),
      filename: filename === undefined ? undefined : unquote(filename),
      contentType: headers.get("content-type")?.trim(),
      bytes: Buffer.from(part.subarray(headEnd + 4)),
    });
    pos = end + between.length;
  }
}

function decodeMultipart(
  op: Operation,
  raw: Buffer,
  contentTypeHeader: string | undefined,
): DecodedBody {
  const boundary = contentTypeHeader ? headerParam(contentTypeHeader, "boundary") : undefined;
  if (!boundary) {
    return {
      ok: false,
      status: 400,
      message: "A multipart/form-data body needs a Content-Type header naming its boundary.",
    };
  }
  const parts = multipartParts(raw, boundary);
  if (!parts) {
    return { ok: false, status: 400, message: "Request body is not valid multipart/form-data." };
  }
  const grouped = new Map<string, unknown[]>();
  for (const part of parts) {
    const schema = fieldSchema(op, part.name);
    const itemSchema =
      schemaType(schema) === "array" ? ((schema?.items ?? {}) as JsonSchema) : schema;
    let value: unknown;
    if (part.filename !== undefined || isBinaryFieldSchema(itemSchema)) {
      // Bytes reach an agent as base64, the only way JSON carries them: the
      // exact inverse of the runtime turning an agent's base64 into a file part.
      value = part.bytes.toString("base64");
    } else if (part.contentType && bodyEncodingFor(part.contentType) === "json") {
      const parsed = parseJson(part.bytes);
      value = parsed.ok ? parsed.value : part.bytes.toString("utf8");
    } else {
      value = scalar(part.bytes.toString("utf8"), schemaType(itemSchema));
    }
    const values = grouped.get(part.name) ?? [];
    values.push(value);
    grouped.set(part.name, values);
  }
  const out: Record<string, unknown> = {};
  for (const [name, values] of grouped) {
    const isArray = schemaType(fieldSchema(op, name)) === "array";
    out[name] = isArray || values.length > 1 ? values : values[0];
  }
  return { ok: true, value: out };
}

/**
 * Decode a request body for the operation it was routed to. An empty body is
 * `undefined` (absent), never an error: whether a body is required is a
 * contract question the simulator's own gates answer.
 */
export function decodeRequestBody(
  op: Operation,
  raw: Buffer,
  contentTypeHeader: string | undefined,
): DecodedBody {
  if (raw.length === 0 || raw.toString("utf8").trim() === "") return { ok: true, value: undefined };
  const declared = op.input.body?.contentType;
  if (declared === undefined) return { ok: true, value: decodeUndeclared(raw, contentTypeHeader) };
  switch (bodyEncodingFor(declared)) {
    case "json":
      return parseJson(raw);
    case "form_urlencoded":
      return decodeForm(op, raw);
    case "multipart":
      return decodeMultipart(op, raw, contentTypeHeader);
    default:
      // A content type the runtime refuses to encode never arrives from it;
      // another client's text is passed through as text rather than guessed at.
      return { ok: true, value: raw.toString("utf8") };
  }
}

/**
 * A body the contract does not declare (an operation without one, or a
 * request no route matched): recorded for the trace, never refused, since
 * nothing about it can be wrong. JSON when it parses, else the text.
 */
export function decodeUndeclared(raw: Buffer, contentTypeHeader: string | undefined): unknown {
  const text = raw.toString("utf8");
  if (text.trim() === "") return undefined;
  const media = contentTypeHeader ? mediaTypeOf(contentTypeHeader) : "";
  if (media === "" || bodyEncodingFor(media) === "json" || media === "text/plain") {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
