import {
  agentPropKey,
  isModeledIdempotencyCarrierInput,
  type JsonSchema,
  materializeSchemaBranches,
  type Operation,
  operationInputSchema,
  operationSafetyInputKeys,
  resolveIdempotencyCarrier,
} from "@anvil/air";
import { z } from "zod";
import { describeStringConstraints, stringAccepts, stringExample } from "./mock-string.js";

/**
 * Example synthesis for an operation's inputs: the skill's examples/ dir, the
 * CLI's `--examples`, and the loopback self-test all feed exactly this to a
 * tool. The generated MCP server validates arguments with zod built from the
 * same AIR input schema, so a synthesized value must satisfy that schema the
 * way zod reads it — `format`, `pattern`, `enum`, `const`, lengths, numeric
 * bounds, array bounds, and `oneOf` (exactly one alternative). Where the
 * schema admits no value at all, or a `oneOf`'s alternatives cannot be told
 * apart, synthesis says so in a {@link ExampleProblem} rather than teaching a
 * value the tool will refuse.
 */

/** A reason the synthesized example cannot satisfy the schema it was built from. */
export interface ExampleProblem {
  /** Input-surface path of the offending schema, e.g. `body.from.id` or `body.body`. */
  path: string;
  /**
   * `unsatisfiable`: no value satisfies the schema (a contradiction such as
   * `format: uuid` with `maxLength: 24`, or an empty `enum`). `indiscriminable_union`:
   * a `oneOf` whose alternatives all accept the synthesized value, so no value
   * matches exactly one; a manifest `params.<input>.one_of` narrowing resolves it.
   */
  kind: "unsatisfiable" | "indiscriminable_union";
  detail: string;
}

export interface ExampleInputReport {
  input: Record<string, unknown>;
  problems: ExampleProblem[];
}

/** Example arguments for an operation, keyed by input-surface name (`agentPropKey`). */
export function exampleInput(op: Operation): Record<string, unknown> {
  return exampleInputReport(op).input;
}

/**
 * Example arguments for an operation plus every reason they may still be
 * refused by the operation's own input schema. Keys are the *input surface*
 * keys (`propKey`, matching the generated CLI/MCP input schema), not the raw
 * wire names — camelCase spec names surface as snake_case inputs, and an
 * example an agent cannot paste back into the tool would be a lie.
 */
export function exampleInputReport(op: Operation): ExampleInputReport {
  const out: Record<string, unknown> = {};
  const ctx: Synthesis = { cache: new Map(), problems: [] };
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;
  const safetyKeys = operationSafetyInputKeys(op);
  // A null synthesis result carries no valid value: the tool's zod shape (and
  // the executor) treat optional as ABSENT, never null, so an unsynthesizable
  // optional input must be omitted rather than sent as null.
  const set = (key: string, value: unknown, required: boolean) => {
    if (value === null && !required) return;
    out[key] = value;
  };
  for (const p of op.input.params) {
    if (isModeledIdempotencyCarrierInput(binding, p.in, p.name)) continue;
    const key = agentPropKey(p);
    set(key, surfaceExample(p.example, p.schema) ?? synthesize(p.schema, ctx, key, 0), p.required);
  }
  const body = op.input.body;
  if (body?.projection === "fields") {
    for (const f of body.fields) {
      if (isModeledIdempotencyCarrierInput(binding, "body", f.name)) continue;
      const key = agentPropKey(f);
      set(key, synthesize(f.schema, ctx, key, 0), f.required);
    }
  } else if (body) {
    // A required body must synthesize at least {} — a null example would fail
    // the executor's required-input check before a single wire request is made.
    // Use the projected surface schema, which omits a modeled runtime-owned
    // body carrier while AIR's source schema retains it for wire validation.
    const surfaceProperties = operationInputSchema(op).properties as
      | Record<string, JsonSchema>
      | undefined;
    const surfaceSchema = surfaceProperties?.body;
    const example = synthesize(surfaceSchema ?? body.schema, ctx, "body", 0);
    if (example !== null) out.body = example;
    else if (body.required) out.body = {};
  }
  if (op.idempotency.mode === "required") {
    out[safetyKeys.idempotencyKey] = `${op.canonicalName}-example-key`;
  }
  if (op.confirmation.required) out[safetyKeys.confirm] = true;
  return { input: out, problems: ctx.problems };
}

/**
 * A declared example is only usable when the tool surface would accept it. Real
 * specs (Coda) put the *wire serialization* on array params (`example:
 * "fetcher,custom"` for a form-style comma-join) and even type-mismatched
 * values (`example: true` on a string enum) — which the generated zod shape
 * rightly rejects. Repair the recoverable shape (split the comma-join back
 * into items) and drop anything else that would not validate, so the caller
 * falls back to schema synthesis instead of teaching the lie.
 */
function surfaceExample(example: unknown, schema: JsonSchema | undefined): unknown {
  if (example === undefined || example === null || schema === undefined) return undefined;
  if (declaredType(schema) === "array" && !Array.isArray(example)) {
    if (typeof example === "string") return example.split(",").map((item) => item.trim());
    return [example];
  }
  return admitsExample(schema, example) ? example : undefined;
}

/** Cap on nested object/array depth for a synthesized example (defense in depth —
 * memoization below already makes a shared subschema O(1) on repeat visits, but a
 * long *unshared* chain should still terminate quickly rather than build a huge
 * example nobody reads). */
const MAX_EXAMPLE_DEPTH = 8;

/** Most items synthesized for one array, however large its `minItems`. */
const MAX_ARRAY_ITEMS = 8;

interface Synthesis {
  /**
   * Memoized by schema object identity: a heavily cross-referential real spec
   * (Stripe's ~860 schemas, each commonly reachable from dozens of operations)
   * reaches the same nested schema object from many call sites, and without
   * this cache each occurrence recomputed its whole example subtree from
   * scratch — bundle generation for such a spec effectively hung. `parse.ts`'s
   * `decycleDocument` already gives repeated references to the same subschema
   * a stable, shared object identity, which is exactly what this cache keys
   * off. An entry carries the problems found beneath it, with paths relative
   * to the schema, so a repeat visit reports them at its own position.
   */
  cache: Map<JsonSchema, Memo>;
  problems: ExampleProblem[];
}

interface Memo {
  value: unknown;
  problems: ExampleProblem[];
}

/**
 * Best-effort example value from a JSON schema. See {@link exampleInputReport}
 * for the contract; this form keeps the familiar value-only signature (the
 * `cache` is the memo table shared across one operation's inputs).
 */
export function exampleFromSchema(
  schema: JsonSchema | undefined,
  cache: Map<JsonSchema, unknown> = new Map(),
  depth = 0,
): unknown {
  const ctx: Synthesis = { cache: new Map(), problems: [] };
  for (const [key, value] of cache) ctx.cache.set(key, { value, problems: [] });
  const value = synthesize(schema, ctx, "", depth);
  for (const [key, memo] of ctx.cache) cache.set(key, memo.value);
  return value;
}

/** Example value plus the problems found beneath `schema`, for callers that report. */
export function exampleFromSchemaReport(schema: JsonSchema | undefined): {
  value: unknown;
  problems: ExampleProblem[];
} {
  const ctx: Synthesis = { cache: new Map(), problems: [] };
  return { value: synthesize(schema, ctx, "", 0), problems: ctx.problems };
}

const join = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

function report(ctx: Synthesis, path: string, kind: ExampleProblem["kind"], detail: string): void {
  ctx.problems.push({ path, kind, detail });
}

/** Replay a memo's problems at the position the schema is reached from now. */
function replay(ctx: Synthesis, memo: Memo, path: string): unknown {
  for (const problem of memo.problems) {
    ctx.problems.push({ ...problem, path: path + problem.path });
  }
  return memo.value;
}

/** Record `value` for `schema`, remembering the problems found since `start` relative to `path`. */
function remember(ctx: Synthesis, schema: JsonSchema, path: string, start: number, value: unknown) {
  const problems = ctx.problems
    .slice(start)
    .map((problem) => ({ ...problem, path: problem.path.slice(path.length) }));
  ctx.cache.set(schema, { value, problems });
  return value;
}

function synthesize(
  schema: JsonSchema | undefined,
  ctx: Synthesis,
  path: string,
  depth: number,
): unknown {
  if (!schema) return null;
  if (Object.hasOwn(schema, "const")) return schema.const;
  const cached = ctx.cache.get(schema);
  if (cached !== undefined && cached.value !== undefined) return replay(ctx, cached, path);
  const start = ctx.problems.length;
  // A literal `example: null` (HubSpot stamps one on nearly every schema) is an
  // annotation, not a synthesizable value — null never validates against the
  // tool's zod shape or the mock's contract, so fall through to the structure.
  // A declared example that the schema itself refuses (Intercom's 24-character
  // ObjectId on a `format: uuid` field) is an annotation too.
  const declared = declaredExample(schema);
  if (declared !== undefined) return declared;
  if (Array.isArray(schema.enum)) {
    const value = schema.enum.find((v) => v !== null);
    if (value !== undefined) return value;
    if (schema.enum.length === 0) {
      report(ctx, path, "unsatisfiable", "`enum` lists no values, so no value is allowed");
      return null;
    }
  }
  if (depth >= MAX_EXAMPLE_DEPTH) return declaredType(schema) === "array" ? [] : {};
  // Materialized `allOf`: synthesize every member and deep-merge the object
  // results (later members win on key conflict). Real lowered specs compose a
  // depth-truncation stub with the object carrying the actual fields — the stub
  // contributes nothing, the fields must survive.
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const parts = schema.allOf.map((m) => synthesize(m as JsonSchema, ctx, path, depth + 1));
    const objects = parts.filter(isRecord);
    if (objects.length > 0) {
      const merged = objects.reduce((acc, part) => deepMergeExamples(acc, part));
      return remember(ctx, schema, path, start, merged);
    }
    return parts.find((p) => p !== null && p !== undefined) ?? {};
  }
  const keyword = Array.isArray(schema.oneOf)
    ? "oneOf"
    : Array.isArray(schema.anyOf)
      ? "anyOf"
      : undefined;
  if (keyword) {
    const value = unionExample(schema, keyword, ctx, path, depth);
    return remember(ctx, schema, path, start, value);
  }
  return ownExample(schema, ctx, path, depth);
}

/* -------------------------------------------------------------------------- */
/* Declared examples                                                          */
/* -------------------------------------------------------------------------- */

/** The first declared example (`example`, then `examples`) the schema itself admits. */
function declaredExample(schema: JsonSchema): unknown {
  const candidates: unknown[] = [];
  if (schema.example !== undefined && schema.example !== null) candidates.push(schema.example);
  if (Array.isArray(schema.examples)) {
    candidates.push(...schema.examples.filter((e) => e !== null && e !== undefined));
  }
  return candidates.find((candidate) => admitsExample(schema, candidate));
}

/**
 * Whether the schema's own scalar contract admits `value`. Objects and arrays
 * are checked for shape only: their members are what the tool validates, and a
 * vendor's object example is still the best teaching material when its shape
 * is right.
 */
function admitsExample(schema: JsonSchema, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => canon(e) === canon(value))) {
    return false;
  }
  if (Object.hasOwn(schema, "const") && canon(schema.const) !== canon(value)) return false;
  switch (declaredType(schema)) {
    case "string":
      return typeof value === "string" && stringAccepts(schema, value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && numberAccepts(schema, value);
    case "number":
      return typeof value === "number" && numberAccepts(schema, value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return !isRecord(schema.properties) || isRecord(value);
  }
}

const canon = (value: unknown) => JSON.stringify(value);

/* -------------------------------------------------------------------------- */
/* Own structure                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The type a schema declares, preferring the non-null member of a type list
 * (`type: ["string", "null"]`): null is a legal value there, but the string is
 * the one worth teaching.
 */
function declaredType(schema: JsonSchema): string | undefined {
  const raw = schema.type;
  if (Array.isArray(raw)) {
    const types = raw.filter((t): t is string => typeof t === "string");
    return types.find((t) => t !== "null") ?? types[0];
  }
  return typeof raw === "string" ? raw : undefined;
}

/** Synthesize from the schema's own declared structure (no compositors). */
function ownExample(schema: JsonSchema, ctx: Synthesis, path: string, depth: number): unknown {
  switch (declaredType(schema)) {
    case "string": {
      const value = stringExample(schema);
      if (value === null) {
        report(
          ctx,
          path,
          "unsatisfiable",
          `no string satisfies ${describeStringConstraints(schema) || "the declared string constraints"}`,
        );
      }
      return value;
    }
    case "integer":
    case "number": {
      const value = numberExample(schema, declaredType(schema) === "integer");
      if (value === null) {
        report(
          ctx,
          path,
          "unsatisfiable",
          `no ${declaredType(schema)} satisfies ${describeNumberConstraints(schema)}`,
        );
      }
      return value;
    }
    case "boolean":
      return true;
    case "null":
      return null;
    case "array":
      return arrayExample(schema, ctx, path, depth);
    case "object":
      return objectExample(schema, ctx, path, depth);
    default: {
      // No declared type. A schema that still carries `properties` (or a
      // `required` list — an object constraint in all but name) is an object;
      // a bare annotation stub (a depth-truncation marker holding only
      // `description` etc.) synthesizes as {} so a composed/required body
      // never falls to null on its account.
      if (isRecord(schema.properties) || Array.isArray(schema.required)) {
        return objectExample(schema, ctx, path, depth);
      }
      if (Object.keys(schema).every((k) => ANNOTATION_KEYS.has(k))) return {};
      return null;
    }
  }
}

/* ---- numbers ---- */

interface NumberBounds {
  lo: number;
  hi: number;
  loExclusive: boolean;
  hiExclusive: boolean;
  step: number | undefined;
}

function numberBounds(schema: JsonSchema, integer: boolean): NumberBounds {
  let lo = typeof schema.minimum === "number" ? schema.minimum : -Infinity;
  let hi = typeof schema.maximum === "number" ? schema.maximum : Infinity;
  // Draft-4 (OpenAPI 3.0) spells exclusivity as a boolean beside min/max;
  // 2019-09+ (OpenAPI 3.1) as the bound itself.
  let loExclusive = schema.exclusiveMinimum === true;
  let hiExclusive = schema.exclusiveMaximum === true;
  if (typeof schema.exclusiveMinimum === "number" && schema.exclusiveMinimum >= lo) {
    lo = schema.exclusiveMinimum;
    loExclusive = true;
  }
  if (typeof schema.exclusiveMaximum === "number" && schema.exclusiveMaximum <= hi) {
    hi = schema.exclusiveMaximum;
    hiExclusive = true;
  }
  const multiple =
    typeof schema.multipleOf === "number" && schema.multipleOf > 0 ? schema.multipleOf : undefined;
  const step = multiple ?? (integer ? 1 : undefined);
  return { lo, hi, loExclusive, hiExclusive, step };
}

function numberAccepts(schema: JsonSchema, value: number): boolean {
  const integer = declaredType(schema) === "integer";
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) return false;
  const { lo, hi, loExclusive, hiExclusive, step } = numberBounds(schema, integer);
  if (loExclusive ? value <= lo : value < lo) return false;
  if (hiExclusive ? value >= hi : value > hi) return false;
  if (step !== undefined && typeof schema.multipleOf === "number") {
    const quotient = value / step;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return false;
  }
  return true;
}

/**
 * A number inside the declared bounds: the familiar `1` when it fits (the
 * lower bound when `1` does not), snapped up to the next multiple and, for an
 * integer, to the next whole number. Null when the bounds admit nothing.
 */
function numberExample(schema: JsonSchema, integer: boolean): number | null {
  const bounds = numberBounds(schema, integer);
  const { lo, hi, loExclusive, hiExclusive, step } = bounds;
  const admits = (value: number) => numberAccepts(schema, value);
  if (admits(1)) return 1;
  let candidate: number;
  if (Number.isFinite(lo)) {
    candidate = loExclusive ? lo + (step ?? (Number.isFinite(hi) ? (hi - lo) / 2 : 1)) : lo;
  } else if (Number.isFinite(hi)) {
    candidate = hiExclusive ? hi - (step ?? 1) : hi;
  } else {
    candidate = step ?? 1;
  }
  if (step !== undefined) {
    const snapped = Number.isFinite(lo)
      ? Math.ceil(candidate / step - 1e-9) * step
      : Math.floor(candidate / step + 1e-9) * step;
    candidate = Number.isInteger(step) ? snapped : Number(snapped.toPrecision(12));
  }
  if (integer) candidate = Math.ceil(candidate);
  if (admits(candidate)) return candidate;
  // An exclusive integer bound snapped onto itself: step once more inward.
  if (step !== undefined) {
    const inward = Number.isFinite(lo) ? candidate + step : candidate - step;
    if (admits(inward)) return inward;
  }
  return null;
}

function describeNumberConstraints(schema: JsonSchema): string {
  const parts: string[] = [];
  for (const key of ["minimum", "exclusiveMinimum", "maximum", "exclusiveMaximum", "multipleOf"]) {
    if (schema[key] !== undefined) parts.push(`${key} ${String(schema[key])}`);
  }
  return parts.join(", ") || "the declared numeric constraints";
}

/* ---- arrays ---- */

function arrayExample(schema: JsonSchema, ctx: Synthesis, path: string, depth: number): unknown {
  const minimum =
    typeof schema.minItems === "number" && Number.isSafeInteger(schema.minItems)
      ? Math.max(0, schema.minItems)
      : 0;
  const maximum =
    typeof schema.maxItems === "number" && Number.isSafeInteger(schema.maxItems)
      ? schema.maxItems
      : Infinity;
  if (maximum < minimum) {
    report(ctx, path, "unsatisfiable", `minItems ${minimum} exceeds maxItems ${maximum}`);
    return null;
  }
  if (maximum === 0) return [];
  const count = Math.min(Math.max(1, minimum), MAX_ARRAY_ITEMS, maximum);
  const items = schema.items as JsonSchema | undefined;
  const first = synthesize(items, ctx, `${path}[0]`, depth + 1);
  const out: unknown[] = [first];
  for (let i = 1; i < count; i++) {
    out.push(schema.uniqueItems === true ? (variant(items, first, i) ?? first) : first);
  }
  if (schema.uniqueItems === true && minimum > 1) {
    const distinct = new Set(out.map(canon)).size;
    if (distinct < Math.min(minimum, MAX_ARRAY_ITEMS)) {
      report(
        ctx,
        path,
        "unsatisfiable",
        `uniqueItems with minItems ${minimum}, but only ${distinct} distinct value(s) can be synthesized for the items schema`,
      );
    }
  }
  return out;
}

/**
 * A further distinct member for a `uniqueItems` array: the i-th enum value, the
 * base integer stepped up, or the base string with a suffix — each checked
 * against the items schema, so a variant is never a value the tool refuses.
 */
function variant(items: JsonSchema | undefined, base: unknown, i: number): unknown {
  if (!items) return typeof base === "number" ? base + i : `${String(base)}-${i}`;
  if (Array.isArray(items.enum)) {
    const value = items.enum.filter((v) => v !== null)[i];
    return value !== undefined ? value : undefined;
  }
  if (typeof base === "number") {
    const integer = declaredType(items) === "integer";
    const step = typeof items.multipleOf === "number" ? items.multipleOf : 1;
    const candidate = base + i * step;
    return numberAccepts({ ...items, type: integer ? "integer" : "number" }, candidate)
      ? candidate
      : undefined;
  }
  if (typeof base === "string" && declaredType(items) === "string") {
    const candidate = `${base}-${i}`;
    return stringAccepts(items, candidate) ? candidate : undefined;
  }
  return undefined;
}

/* ---- objects ---- */

function objectExample(
  schema: JsonSchema,
  ctx: Synthesis,
  path: string,
  depth: number,
): Record<string, unknown> {
  const props = (schema.properties as Record<string, JsonSchema>) ?? {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const obj: Record<string, unknown> = {};
  const start = ctx.problems.length;
  ctx.cache.set(schema, { value: obj, problems: [] }); // set before recursing so a cycle in unshared data still terminates
  for (const [k, v] of Object.entries(props)) {
    const value = synthesize(v, ctx, join(path, k), depth + 1);
    // Zod reads an optional property as ABSENT, never null — and `nullable`
    // alone does not make null acceptable to its importer. A property that
    // synthesized nothing is left out; a required one has to stay so the
    // refusal names it.
    if (value === null && !required.has(k)) continue;
    obj[k] = value;
  }
  // A record/map schema (`additionalProperties`-typed, no fixed properties)
  // gets one representative entry so the synthesized value exercises the map
  // shape instead of the degenerate {}.
  const extra = schema.additionalProperties;
  if (Object.keys(obj).length === 0 && isRecord(extra)) {
    obj.key = synthesize(extra as JsonSchema, ctx, join(path, "key"), depth + 1);
  }
  remember(ctx, schema, path, start, obj);
  return obj;
}

/* -------------------------------------------------------------------------- */
/* Unions                                                                     */
/* -------------------------------------------------------------------------- */

type Validator = { accepts: (value: unknown) => boolean } | undefined;

/**
 * Validators for a union's alternatives, as the generated MCP server sees them
 * (`materializeSchemaBranches` makes inherited object rules explicit on
 * required-only branches). Patterns are removed first: a spec-controlled regex
 * must never run in the uninterruptible runtime validator at build time, and
 * alternatives are told apart by structure, type, `enum` and `const`, not by a
 * regex. An alternative zod cannot import yields no validator (`undefined`),
 * which disables discrimination for that union rather than guessing.
 */
const validatorCache = new WeakMap<JsonSchema, Validator[]>();

function alternativeValidators(schema: JsonSchema, keyword: "oneOf" | "anyOf"): Validator[] {
  const cached = validatorCache.get(schema);
  if (cached) return cached;
  const materialized = materializeSchemaBranches(schema)[keyword];
  const validators: Validator[] = (Array.isArray(materialized) ? materialized : []).map((alt) => {
    try {
      const parser = z.fromJSONSchema(
        withoutPatterns(alt as JsonSchema) as Parameters<typeof z.fromJSONSchema>[0],
      );
      return { accepts: (value: unknown) => parser.safeParse(value).success };
    } catch {
      return undefined;
    }
  });
  validatorCache.set(schema, validators);
  return validators;
}

function withoutPatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutPatterns);
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "pattern" || key === "patternProperties") continue;
    out[key] = withoutPatterns(value);
  }
  return out;
}

/**
 * `oneOf`/`anyOf`: a schema may carry its own structure AND alternatives (a
 * base object whose anyOf members only add `required` constraints — Intercom's
 * create-contact); there the branch *refines* the base rather than replacing
 * it. For `anyOf` the first alternative whose witness it accepts wins. For
 * `oneOf` — strict in zod: "more than one option matched" is a refusal — the
 * witness must match exactly one alternative, so each alternative is tried in
 * turn; when none has a witness of its own, the union is not discriminable by
 * value and is reported as such.
 */
function unionExample(
  schema: JsonSchema,
  keyword: "oneOf" | "anyOf",
  ctx: Synthesis,
  path: string,
  depth: number,
): unknown {
  const alternatives = schema[keyword] as JsonSchema[];
  if (alternatives.length === 0) {
    report(
      ctx,
      path,
      "unsatisfiable",
      `\`${keyword}\` lists no alternatives, so no value is allowed`,
    );
    return null;
  }
  const validators = alternativeValidators(schema, keyword);
  const undecidable = validators.some((v) => v === undefined);
  let fallback: { value: unknown; problems: ExampleProblem[] } | undefined;
  for (let i = 0; i < alternatives.length; i++) {
    // Problems found while exploring an alternative belong to the example
    // only if that alternative is the one taught.
    const scratch: Synthesis = { cache: ctx.cache, problems: [] };
    const value = alternativeExample(schema, alternatives, i, scratch, path, depth);
    const commit = () => {
      ctx.problems.push(...scratch.problems);
      return value;
    };
    if (undecidable) return commit();
    const matches = validators.map((v) => v?.accepts(value) === true);
    if (keyword === "anyOf") {
      if (matches[i]) return commit();
    } else if (matches.filter(Boolean).length === 1) {
      return commit();
    }
    fallback ??= { value, problems: scratch.problems };
  }
  const first = fallback as { value: unknown; problems: ExampleProblem[] };
  ctx.problems.push(...first.problems);
  if (keyword === "oneOf") {
    const labels = alternatives.map((alt, i) => describeAlternative(alt, i)).join(", ");
    report(
      ctx,
      path,
      "indiscriminable_union",
      `oneOf alternatives [${labels}] cannot be told apart by value: every synthesized value matches more than one (or none), so no value matches exactly one`,
    );
  } else {
    report(
      ctx,
      path,
      "unsatisfiable",
      `no synthesized value satisfies any anyOf alternative [${alternatives.map((alt, i) => describeAlternative(alt, i)).join(", ")}]`,
    );
  }
  return first.value;
}

/**
 * A label a reviewer can match to a manifest `one_of`: the alternative's title
 * when it has one, else its type and the first few property names — AIR
 * carries no component names, so an object alternative is recognised by what
 * it declares, and the index is what the manifest can always name.
 */
function describeAlternative(alt: JsonSchema, index: number): string {
  if (typeof alt.title === "string") return `${index}: ${alt.title}`;
  const type = declaredType(alt) ?? "untyped";
  const keys = isRecord(alt.properties) ? Object.keys(alt.properties) : [];
  if (keys.length === 0) return `${index}: ${type}`;
  const shown = keys.slice(0, 4).join(", ") + (keys.length > 4 ? ", …" : "");
  return `${index}: ${type}{${shown}}`;
}

/** The witness for alternative `index`, refined by or merged with the base structure. */
function alternativeExample(
  schema: JsonSchema,
  alternatives: JsonSchema[],
  index: number,
  ctx: Synthesis,
  path: string,
  depth: number,
): unknown {
  const chosen = alternatives[index] as JsonSchema;
  const branch = synthesize(chosen, ctx, path, depth + 1);
  if (schema.type === undefined && !isRecord(schema.properties)) return branch;
  const own = ownExample(schema, ctx, path, depth);
  if (Array.isArray(schema.oneOf) && isRecord(own) && isRecord(branch)) {
    // oneOf branches with only `required` constrain a shared properties map.
    // Emitting every sibling discriminator makes multiple branches match.
    const keys = new Set([
      ...((schema.required as string[]) ?? []),
      ...((chosen.required as string[]) ?? []),
      ...Object.keys((chosen.properties as object) ?? {}),
      ...Object.keys(branch),
    ]);
    const selected = Object.fromEntries(Object.entries(own).filter(([key]) => keys.has(key)));
    return deepMergeExamples(selected, branch);
  }
  if (isRecord(own) && isRecord(branch)) return deepMergeExamples(own, branch);
  return own !== null && own !== undefined ? own : branch;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Schema keys that annotate without constraining — a schema of only these is a stub. */
const ANNOTATION_KEYS = new Set([
  "description",
  "title",
  "deprecated",
  "readOnly",
  "writeOnly",
  "nullable",
  "default",
  "$comment",
  "externalDocs",
  "xml",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge two synthesized object examples; `b` wins on leaf conflicts (allOf order). */
function deepMergeExamples(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isRecord(prev) && isRecord(v) ? deepMergeExamples(prev, v) : v;
  }
  return out;
}

/**
 * One line a reviewer can act on for a synthesis problem, naming the manifest
 * remedy when one exists. `inputName(path)` maps a surface path to the wire
 * name a `params` entry would use — the top-level body property (`body.body`
 * → `body`), the whole body (`body` → `body`), or a parameter.
 */
export function describeExampleProblem(problem: ExampleProblem): string {
  const segments = problem.path.split(".");
  const top = segments[0] ?? problem.path;
  // `body.<field>` is the body's top-level field and `body.<field>.<prop>…` a
  // property below it, which a dotted `params` name reaches; `body` alone is
  // the whole body; anything else at the top is a parameter, whose scalar
  // schema has nothing below it a manifest could name.
  const reachable = top === "body" || segments.length === 1;
  const wireName = top === "body" && segments.length >= 2 ? segments.slice(1).join(".") : top;
  if (problem.kind === "indiscriminable_union") {
    const remedy = reachable
      ? `narrow it with a manifest params entry (params: { ${wireName}: { one_of: <component name or index> } })`
      : "it lies below a top-level input, out of a manifest params entry's reach, so the source schema needs a discriminator";
    return `${problem.path}: ${problem.detail}; ${remedy}`;
  }
  const remedy = reachable
    ? `the source schema admits no value here; a manifest params entry (params: { ${wireName}: { type: ... } }) can retype a top-level input`
    : "the source schema admits no value here and it lies below a top-level input, out of a manifest params entry's reach";
  return `${problem.path}: ${problem.detail}; ${remedy}`;
}
