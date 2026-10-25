import { describe, expect, it } from "vitest";
import { decodeDeepObject } from "./body-decoding.js";

describe("decodeDeepObject", () => {
  const schema = { type: "object", additionalProperties: { type: "string" } } as const;

  it("folds bracketed pairs into the value, typed by the schema path", () => {
    expect(
      decodeDeepObject("metadata", schema, [
        ["metadata[order]", "o_1"],
        ["metadata[tier]", "gold"],
      ]),
    ).toEqual({ order: "o_1", tier: "gold" });
    expect(
      decodeDeepObject("expand", { type: "array", items: { type: "string" } }, [
        ["expand[0]", "customer"],
        ["expand[1]", "invoice"],
      ]),
    ).toEqual(["customer", "invoice"]);
  });

  it("never walks into Object.prototype on a hostile bracketed key", () => {
    const before = Object.getOwnPropertyNames(Object.prototype).length;
    const value = decodeDeepObject("metadata", schema, [
      ["metadata[__proto__][polluted]", "yes"],
      ["metadata[constructor][prototype][polluted]", "yes"],
      ["metadata[prototype][polluted]", "yes"],
      ["metadata[toString][x]", "own, not inherited"],
      ["metadata[order]", "o_1"],
    ]);
    // Nothing leaked onto the shared prototype, in either direction.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).length).toBe(before);
    // The hostile pairs are dropped; an inherited name is just an own key.
    expect(value).toEqual({ order: "o_1", toString: { x: "own, not inherited" } });
    expect(Object.keys(value as object)).toEqual(["toString", "order"]);
  });

  it("drops an index that would allocate a sparse array for one pair", () => {
    const value = decodeDeepObject("expand", { type: "array", items: { type: "string" } }, [
      ["expand[0]", "a"],
      ["expand[4294967294]", "b"],
    ]);
    expect(value).toEqual(["a"]);
  });
});
