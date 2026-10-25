import type { JsonSchema } from "@anvil/air";
import { z } from "zod";
import { patternExample, patternMatches } from "./mock-pattern.js";

/** The length bounds a string schema declares, or undefined when they contradict. */
function lengthBounds(schema: JsonSchema): { minimum: number; maximum: number } | undefined {
  const minimum = typeof schema.minLength === "number" ? schema.minLength : 0;
  const maximum = typeof schema.maxLength === "number" ? schema.maxLength : 2048;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    minimum > 2048
  )
    return undefined;
  return { minimum, maximum };
}

/**
 * The format + length half of a string contract as the generated MCP server
 * enforces it (zod's JSON Schema importer). Patterns are deliberately left to
 * the bounded matcher; see `stringExample`.
 */
function formatValidator(schema: JsonSchema, bounds: { minimum: number; maximum: number }) {
  return z.fromJSONSchema({
    type: "string",
    ...(schema.format !== undefined ? { format: schema.format } : {}),
    minLength: bounds.minimum,
    maxLength: bounds.maximum,
  } as Parameters<typeof z.fromJSONSchema>[0]);
}

/**
 * Whether a string already satisfies the schema's own string contract: length,
 * format, and pattern. A declared `example` that fails this is an annotation
 * the tool surface would reject (Intercom declares a 24-character ObjectId as
 * the example of a `format: uuid` field), so it must not be taught.
 */
export function stringAccepts(schema: JsonSchema, value: string): boolean {
  const bounds = lengthBounds(schema);
  if (!bounds) return false;
  if (value.length < bounds.minimum || value.length > bounds.maximum) return false;
  if (schema.format !== undefined) {
    try {
      if (!formatValidator(schema, bounds).safeParse(value).success) return false;
    } catch {
      return false;
    }
  }
  if (typeof schema.pattern === "string") return patternMatches(schema.pattern, value) === true;
  return true;
}

/** Validate the full string contract before accepting a generated witness. */
export function stringExample(schema: JsonSchema): string | null {
  const bounds = lengthBounds(schema);
  if (!bounds) return null;
  const { minimum, maximum } = bounds;
  const base = formatExample(schema.format);
  const length = Math.max(minimum, Math.min(maximum, base.length));
  const candidate = length <= base.length ? base.slice(0, length) : base.padEnd(length, "x");
  if (schema.format === undefined && typeof schema.pattern !== "string") return candidate;
  try {
    // Patterns are checked by the bounded matcher; never feed one back to the
    // uninterruptible runtime validator while generating examples.
    const validator = formatValidator(schema, bounds);
    const accept = (value: string) => validator.safeParse(value).success;
    if (typeof schema.pattern === "string") {
      return (
        patternExample(schema.pattern, {
          candidates: [base, candidate],
          minLength: minimum,
          maxLength: maximum,
          accept,
        }) ?? null
      );
    }
    return accept(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * The string constraints a schema declares, for a diagnostic: "format uuid,
 * maxLength 24". Empty when it declares none.
 */
export function describeStringConstraints(schema: JsonSchema): string {
  const parts: string[] = [];
  if (schema.format !== undefined) parts.push(`format ${String(schema.format)}`);
  if (typeof schema.pattern === "string") parts.push(`pattern ${schema.pattern}`);
  if (typeof schema.minLength === "number") parts.push(`minLength ${schema.minLength}`);
  if (typeof schema.maxLength === "number") parts.push(`maxLength ${schema.maxLength}`);
  return parts.join(", ");
}

function formatExample(format: unknown): string {
  switch (format) {
    case "date":
      return "2026-07-09";
    case "date-time":
      return "2026-07-09T00:00:00Z";
    case "time":
      return "00:00:00Z";
    case "duration":
      return "P1D";
    case "uuid":
    case "guid":
      return "550e8400-e29b-41d4-a716-446655440000";
    case "ulid":
      return "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    case "email":
    case "idn-email":
      return "user@example.com";
    case "uri":
    case "url":
    case "iri":
    case "uri-reference":
    case "iri-reference":
      return "https://example.com/resource";
    case "hostname":
    case "idn-hostname":
      return "api.example.com";
    case "ipv4":
      return "192.0.2.1";
    case "ipv6":
      return "2001:db8::1";
    case "base64":
      return "ZXhhbXBsZQ==";
    case "json-pointer":
      return "/example";
    default:
      return "example";
  }
}
