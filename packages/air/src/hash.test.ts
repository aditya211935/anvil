import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contractHash, hashCanonical, loadAirDocument } from "./index.js";

const doc = {
  service: { id: "svc", version: "1", source: { kind: "openapi", uri: "./s.yaml" } },
  operations: [
    {
      id: "svc.things.get",
      canonicalName: "get_thing",
      displayName: "Get thing",
      description: "Get a thing.",
      sourceRef: { kind: "openapi", path: "/things/{id}", method: "get" },
      effect: { kind: "read", action: "get", risk: "none" },
      input: { params: [] },
      idempotency: { mode: "natural" },
      retries: { mode: "none" },
      confirmation: { required: false },
      auth: { type: "api_key" },
      cli: { command: "svc things get" },
      mcp: { toolName: "svc_get_thing" },
      skill: { intentExamples: ["get a thing"] },
    },
  ],
};

/** The historical implementation: one canonical string, hashed whole. */
function legacyHashCanonical(value: unknown): string {
  const canonicalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = canonicalize((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) as string)
    .digest("hex");
}

describe("hashCanonical", () => {
  it("digests exactly the bytes the single-string form did, so stored hashes stand", () => {
    const samples: unknown[] = [
      doc,
      { z: 1, a: [3, { y: null, x: 'é "\\\n' }], m: undefined, f: () => 1 },
      [undefined, () => 1, Symbol("s"), Number.NaN, Number.POSITIVE_INFINITY, -0, 1e21, ""],
      { date: new Date(0), map: new Map([["k", 1]]), set: new Set([1]), boxed: new Number(2) },
      { nested: { deep: { deeper: { deepest: [[[]], {}] } } } },
      { withToJson: { toJSON: () => ({ b: 1, a: 2 }) }, arr: [{ toJSON: () => undefined }] },
      { omitted: { toJSON: () => undefined }, kept: 1 },
      JSON.parse('{"__proto__":{"authorized":true}}'),
      "a string",
      42,
      true,
      null,
      [],
      {},
    ];
    for (const sample of samples) {
      expect(hashCanonical(sample)).toBe(legacyHashCanonical(sample));
    }
  });

  it("streams: a value whose canonical text is far larger than one chunk still hashes as one", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({ i, text: "x".repeat(40) }));
    expect(hashCanonical(big)).toBe(legacyHashCanonical(big));
  });

  it("refuses a value with no JSON form instead of crashing inside the digest", () => {
    expect(() => hashCanonical(undefined)).toThrow(TypeError);
    expect(() => hashCanonical({ toJSON: () => undefined })).toThrow(TypeError);
    expect(() => hashCanonical({ n: 1n })).toThrow(TypeError);
  });

  it("includes JSON prototype-named properties in contract and approval identities", () => {
    const input = JSON.parse('{"__proto__":{"authorized":true}}');
    expect(hashCanonical(input)).not.toBe(hashCanonical({}));
    expect(hashCanonical({ nested: input })).not.toBe(hashCanonical({ nested: {} }));
  });
  it("is independent of object key insertion order", () => {
    expect(hashCanonical({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashCanonical({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("is sensitive to values and to array order", () => {
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
});

describe("contractHash", () => {
  it("is stable across parses and spelled-out defaults", () => {
    const air = loadAirDocument(doc);
    // Re-parsing (which re-applies defaults) must not move the hash.
    expect(contractHash(loadAirDocument(air))).toBe(contractHash(air));
  });

  it("changes when the contract changes", () => {
    const a = loadAirDocument(doc);
    const b = loadAirDocument(doc);
    (b.operations[0] as { description: string }).description = "Get a different thing.";
    expect(contractHash(b)).not.toBe(contractHash(a));
  });

  it("ignores diagnostics (commentary is not contract)", () => {
    const a = loadAirDocument(doc);
    const b = loadAirDocument({
      ...doc,
      diagnostics: [{ level: "info", code: "note", message: "linted later" }],
    });
    expect(contractHash(b)).toBe(contractHash(a));
  });
});
