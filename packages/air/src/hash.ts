import { createHash, type Hash } from "node:crypto";
import { AirDocument } from "./schema.js";

/**
 * Content-derived identity of an AIR contract. Lives in @anvil/air so both the
 * refinement layer (readiness assessments) and the generators (capability
 * bundles) can stamp the same hash for the same contract without either
 * depending on the other.
 *
 * The hash is sha256 over the canonical JSON of the value: `JSON.stringify` of
 * the value with every object's keys sorted. That text is never built as one
 * string, though — it is written into the digest in chunks as the value is
 * walked. A whole-source compile of a large contract can canonicalize to more
 * than V8's ~512MB string limit, and building the string first turned the
 * hash into an uncaught `RangeError: Invalid string length` thrown from inside
 * `crypto.Hash` — a crash where the serializer two steps later would have
 * reported a size problem. Hashing has no size limit of its own, so it has no
 * business failing on size. The bytes digested are identical to those of the
 * single-string form, so every stored hash is unchanged.
 */

/** Chunk size at which buffered canonical text is flushed into the digest. */
const FLUSH_AT = 1 << 20;

class DigestSink {
  private parts: string[] = [];
  private length = 0;
  constructor(private readonly hash: Hash) {}
  write(text: string): void {
    this.parts.push(text);
    this.length += text.length;
    if (this.length >= FLUSH_AT) this.flush();
  }
  flush(): void {
    if (this.parts.length === 0) return;
    this.hash.update(this.parts.join(""));
    this.parts = [];
    this.length = 0;
  }
}

/** Values `JSON.stringify` leaves out of an object and writes as `null` in an array. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/**
 * The historical single-string serialization of one value, for the one case the
 * streaming walk does not reproduce structurally: an object carrying its own
 * `toJSON`, which `JSON.stringify` would have called on the canonical copy.
 * `undefined` when `JSON.stringify` would have produced nothing for it.
 */
function legacyText(value: unknown): string | undefined {
  return JSON.stringify(canonicalize(value));
}

function hasToJson(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).toJSON === "function"
  );
}

/** Recursively sort object keys so hashing is independent of insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Write `JSON.stringify(canonicalize(value))` to the sink without materializing
 * it. Mirrors `JSON.stringify` exactly: omitted values (`undefined`, functions,
 * symbols) vanish from objects and become `null` in arrays, non-finite numbers
 * become `null`, and a `BigInt` throws as it always has. Any object (a `Date`,
 * a `Map`) is its own enumerable keys, as `canonicalize` has always read it.
 */
function writeCanonical(value: unknown, sink: DigestSink): void {
  if (Array.isArray(value)) {
    sink.write("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) sink.write(",");
      const item = value[i];
      if (isOmitted(item)) sink.write("null");
      else if (hasToJson(item)) sink.write(legacyText(item) ?? "null");
      else writeCanonical(item, sink);
    }
    sink.write("]");
    return;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    sink.write("{");
    let first = true;
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (isOmitted(item)) continue;
      let text: string | undefined;
      if (hasToJson(item)) {
        text = legacyText(item);
        if (text === undefined) continue;
      }
      if (!first) sink.write(",");
      first = false;
      sink.write(JSON.stringify(key));
      sink.write(":");
      if (text !== undefined) sink.write(text);
      else writeCanonical(item, sink);
    }
    sink.write("}");
    return;
  }
  // A scalar: strings are escaped, non-finite numbers are null, BigInt throws.
  sink.write(JSON.stringify(value) as string);
}

/** sha256 hex of the canonical (key-sorted) JSON of a value. */
export function hashCanonical(value: unknown): string {
  const hash = createHash("sha256");
  const sink = new DigestSink(hash);
  if (hasToJson(value)) {
    const text = legacyText(value);
    if (text === undefined) throw new TypeError("hashCanonical: the value has no JSON form");
    sink.write(text);
  } else if (isOmitted(value)) {
    // `JSON.stringify` yields undefined here and `Hash.update(undefined)` threw.
    throw new TypeError("hashCanonical: the value has no JSON form");
  } else {
    writeCanonical(value, sink);
  }
  sink.flush();
  return hash.digest("hex");
}

/**
 * The hash of an AIR document's *contract*: the normalized document minus its
 * diagnostics. Diagnostics are compiler commentary about the contract, not part
 * of it — excluding them means re-linting cannot change what artifacts and
 * assessments claim to be bound to. Normalizing through the schema first makes
 * the hash independent of which optional defaults a caller happened to spell out.
 */
export function contractHash(air: AirDocument): string {
  return hashCanonical({ ...AirDocument.parse(air), diagnostics: undefined });
}
