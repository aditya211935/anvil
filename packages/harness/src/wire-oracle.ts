import {
  agentPropKey,
  bodyEncodingFor,
  type Operation,
  operationSafetyInputKeys,
  resolveIdempotencyCarrier,
  serializeFormField,
  serializeQueryParam,
  serializeSimpleParam,
} from "@anvil/air";

/**
 * The wire oracle the hermetic lanes compare captures against: what the AIR
 * contract promises a call will put on the wire — path, query, headers, body —
 * derived from AIR here, independently of the executor's own request builder,
 * so the self-test is an oracle over the contract and not a mirror of the
 * implementation. The generated mock records a form body and a query string as
 * their on-wire pairs (a repeated key an array), and the oracle expects exactly
 * that shape, through the same `@anvil/air` serialization table the runtime
 * binds through. Split out of bundle-driver.ts, which boots and drives the
 * bundle; this module only says what the wire should hold.
 */

/** A structural divergence between what was sent and what the wire received. */
export interface WireLoss {
  /** JSON path of the divergence, e.g. "body.amount" or "query.limit". */
  path: string;
  sent: unknown;
  received: unknown;
}

/** Headers the mock redacts; their captured value is never comparable. */
export const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
]);

/**
 * A form-urlencoded body as the mock records it after decoding: every value a
 * string, a repeated key an array, a single value a plain string. This mirrors
 * `URLSearchParams` — the one encoding the runtime speaks for forms — so the
 * fidelity oracle compares like with like. Nested values have no form
 * encoding; the runtime refuses them before the wire, so they are left as they
 * are and no capture ever exists to compare them against.
 */
export function formCapture(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (Array.isArray(item) && item.every(isFormPrimitive)) {
      const texts = item.map(String);
      out[name] = texts.length === 1 ? texts[0] : texts;
    } else if (isFormPrimitive(item)) {
      out[name] = String(item);
    } else {
      out[name] = item;
    }
  }
  return out;
}

function isFormPrimitive(value: unknown): value is string | number | boolean | bigint {
  const t = typeof value;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint";
}

export interface ExpectedWire {
  path: string;
  /** Same shape as `CaptureRecord.query`: a repeated key is an array. */
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  /**
   * A JSON body as the value sent; a form body as the mock captures it — the
   * wire pairs keyed by their exact on-wire names (`metadata[order]`), a
   * repeated key an array.
   */
  body: unknown;
}

/** Add one name/value pair the way the mock records it: a repeat becomes an array. */
function addQueryPair(query: Record<string, string | string[]>, name: string, value: string): void {
  const existing = query[name];
  if (existing === undefined) query[name] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else query[name] = [existing, value];
}

function withNestedValue(value: unknown, path: readonly string[], key: string): unknown {
  const root = isRecord(value) ? structuredClone(value) : {};
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (isRecord(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[path[path.length - 1] as string] = key;
  return root;
}

/**
 * The wire request the AIR contract promises for these args. Derived from AIR
 * here, independently of the executor's own request builder — the self-test is
 * an oracle over the contract, not a mirror of the implementation.
 */
export function expectedWire(op: Operation, args: Record<string, unknown>): ExpectedWire {
  let path = op.sourceRef.path ?? "/";
  const query: Record<string, string | string[]> = {};
  const headers: Record<string, string> = {};
  const fields: Record<string, unknown> = {};
  let hasBody = false;
  // Serialized by the one table in @anvil/air that the runtime binds through
  // (`param-style.ts`), so this oracle asks for what the contract promises
  // rather than agreeing with whatever the executor happened to send. A value
  // the table refuses is left off the expectation: the runtime refuses the
  // call before the wire, so no capture exists to compare it against.
  for (const p of op.input.params) {
    const value = args[agentPropKey(p)];
    if (value === undefined || value === null) continue;
    if (p.in === "path") {
      const bound = serializeSimpleParam(p, value, encodeURIComponent);
      if (bound.ok) path = path.replace(`{${p.name}}`, bound.text);
    } else if (p.in === "query") {
      const bound = serializeQueryParam(p, value);
      if (bound.ok) for (const [name, text] of bound.pairs) addQueryPair(query, name, text);
    } else if (p.in === "header" && !REDACTED_HEADERS.has(p.name.toLowerCase())) {
      const bound = serializeSimpleParam(p, value);
      if (bound.ok) headers[p.name.toLowerCase()] = bound.text;
    } else if (p.in === "body") {
      fields[p.name] = value;
      hasBody = true;
    }
  }
  let body: unknown;
  const b = op.input.body;
  if (b?.projection === "fields") {
    for (const f of b.fields) {
      const value = args[agentPropKey(f)];
      if (value === undefined || value === null) continue;
      fields[f.name] = value;
      hasBody = true;
    }
  } else if (b && args.body !== undefined && args.body !== null) {
    body = args.body;
  }
  if (body === undefined && hasBody) body = fields;
  const carrier = resolveIdempotencyCarrier(op);
  const safetyKey = operationSafetyInputKeys(op).idempotencyKey;
  const key = typeof args[safetyKey] === "string" ? args[safetyKey] : undefined;
  if (carrier.ok && carrier.binding && key) {
    const binding = carrier.binding;
    switch (binding.mechanism) {
      case "header":
        if (!REDACTED_HEADERS.has(binding.key.toLowerCase())) {
          headers[binding.key.toLowerCase()] = key;
        }
        break;
      case "query":
        query[binding.key] = key;
        break;
      case "path":
        path = path.replace(`{${binding.key}}`, encodeURIComponent(key));
        break;
      case "body":
        body = withNestedValue(body, binding.path, key);
        break;
    }
  }
  // A form body reaches the wire as `name=value` pairs the mock records under
  // their on-wire names — expect that shape, not the JSON the tool took.
  if (b && bodyEncodingFor(b.contentType) === "form_urlencoded" && isRecord(body)) {
    body = expectedFormBody(b.encoding, body);
  }
  return { path, query, headers, body };
}

/**
 * The form body the contract promises, in the shape the mock captures it: the
 * wire pairs, serialized field by field through the same `@anvil/air` table the
 * runtime binds through, so a deepObject field is expected as its bracketed
 * keys. A field the table refuses is left off, as with a refused parameter —
 * the runtime refuses the whole call, so no capture exists to compare against.
 */
function expectedFormBody(
  encodings: Record<string, { style?: string; explode?: boolean }> | undefined,
  fields: Record<string, unknown>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const encoding = encodings?.[name] as Parameters<typeof serializeFormField>[1];
    const bound = serializeFormField(name, encoding, value);
    if (bound.ok) for (const [key, text] of bound.pairs) addQueryPair(out, key, text);
  }
  return out;
}

/** The mock's query capture shape from a URL: a repeated key becomes an array. */
export function queryCapture(params: URLSearchParams): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [name, value] of params) addQueryPair(query, name, value);
  return query;
}

/** Structural diff producing loss entries with JSON paths; walks both sides. */
export function diff(sent: unknown, received: unknown, path: string, losses: WireLoss[]): void {
  if (isRecord(sent) && isRecord(received)) {
    for (const key of new Set([...Object.keys(sent), ...Object.keys(received)])) {
      diff(sent[key], received[key], `${path}.${key}`, losses);
    }
    return;
  }
  if (Array.isArray(sent) && Array.isArray(received)) {
    if (sent.length !== received.length) {
      losses.push({ path: `${path}.length`, sent: sent.length, received: received.length });
      return;
    }
    for (let i = 0; i < sent.length; i++) diff(sent[i], received[i], `${path}[${i}]`, losses);
    return;
  }
  if (!Object.is(sent, received)) losses.push({ path, sent, received });
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
