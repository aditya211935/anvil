import { describe, expect, it } from "vitest";
import {
  resolveParamSerialization,
  serializeFormField,
  serializeQueryParam,
  serializeSimpleParam,
} from "./param-style.js";

/**
 * The parameter serialization table, asserted against the literal text OpenAPI
 * defines rather than against anything recomputed from the same code — an
 * oracle derived from the implementation moves with the bug instead of
 * catching it.
 */
describe("parameter serialization", () => {
  it("fills in OpenAPI's per-location defaults", () => {
    expect(resolveParamSerialization({ in: "query", name: "q" })).toEqual({
      style: "form",
      explode: true,
    });
    expect(resolveParamSerialization({ in: "cookie", name: "q" })).toEqual({
      style: "form",
      explode: true,
    });
    expect(resolveParamSerialization({ in: "path", name: "q" })).toEqual({
      style: "simple",
      explode: false,
    });
    expect(resolveParamSerialization({ in: "header", name: "q" })).toEqual({
      style: "simple",
      explode: false,
    });
    // A declared style keeps explode's default keyed to the style, not the location.
    expect(resolveParamSerialization({ in: "query", name: "q", style: "pipeDelimited" })).toEqual({
      style: "pipeDelimited",
      explode: false,
    });
    expect(resolveParamSerialization({ in: "query", name: "q", explode: false })).toEqual({
      style: "form",
      explode: false,
    });
  });

  it("serializes query arrays per style", () => {
    const ids = ["a", "b", "c"];
    expect(serializeQueryParam({ in: "query", name: "id" }, ids)).toEqual({
      ok: true,
      pairs: [
        ["id", "a"],
        ["id", "b"],
        ["id", "c"],
      ],
    });
    expect(serializeQueryParam({ in: "query", name: "id", explode: false }, ids)).toEqual({
      ok: true,
      pairs: [["id", "a,b,c"]],
    });
    expect(serializeQueryParam({ in: "query", name: "id", style: "spaceDelimited" }, ids)).toEqual({
      ok: true,
      pairs: [["id", "a b c"]],
    });
    expect(serializeQueryParam({ in: "query", name: "id", style: "pipeDelimited" }, ids)).toEqual({
      ok: true,
      pairs: [["id", "a|b|c"]],
    });
    // Numbers and booleans are atoms, never quoted or JSON-encoded.
    expect(serializeQueryParam({ in: "query", name: "n" }, [1, true])).toEqual({
      ok: true,
      pairs: [
        ["n", "1"],
        ["n", "true"],
      ],
    });
  });

  it("serializes query objects per style, and never as [object Object]", () => {
    const point = { x: 1, y: "two" };
    expect(serializeQueryParam({ in: "query", name: "p" }, point)).toEqual({
      ok: true,
      pairs: [
        ["x", "1"],
        ["y", "two"],
      ],
    });
    expect(serializeQueryParam({ in: "query", name: "p", explode: false }, point)).toEqual({
      ok: true,
      pairs: [["p", "x,1,y,two"]],
    });
    expect(serializeQueryParam({ in: "query", name: "p", style: "deepObject" }, point)).toEqual({
      ok: true,
      pairs: [
        ["p[x]", "1"],
        ["p[y]", "two"],
      ],
    });
    // Absent properties are simply not sent, as with a top-level parameter.
    expect(serializeQueryParam({ in: "query", name: "p" }, { x: 1, y: null })).toEqual({
      ok: true,
      pairs: [["x", "1"]],
    });
  });

  it("refuses the shapes no style gives a meaning to", () => {
    const refused = (p: Parameters<typeof serializeQueryParam>[0], value: unknown) => {
      const result = serializeQueryParam(p, value);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.reason;
    };
    expect(refused({ in: "query", name: "p" }, { a: { b: 1 } })).toContain("nested object");
    expect(refused({ in: "query", name: "p" }, [{ a: 1 }])).toContain("array of objects");
    expect(refused({ in: "query", name: "p", style: "spaceDelimited" }, { a: 1 })).toContain(
      "no defined encoding for an object",
    );
    expect(refused({ in: "query", name: "p", style: "pipeDelimited" }, { a: 1 })).toContain(
      "no defined encoding for an object",
    );
    expect(refused({ in: "query", name: "p", style: "deepObject" }, [() => 1])).toContain(
      "function",
    );
    expect(refused({ in: "query", name: "p" }, () => 1)).toContain("function");
    for (const result of [
      serializeSimpleParam({ in: "path", name: "p" }, { a: [1] }),
      serializeSimpleParam({ in: "header", name: "p" }, [[1]]),
    ]) {
      expect(result.ok).toBe(false);
    }
  });

  it("brackets deepObject recursively: arrays by index, objects by key", () => {
    // Stripe's `expand[0]=charges&expand[1]=customer` — the array reading of a
    // declared deepObject, which OpenAPI 3.0 leaves undefined and every
    // service declaring the style brackets by index.
    expect(
      serializeQueryParam({ in: "query", name: "expand", style: "deepObject" }, ["a", "b"]),
    ).toEqual({
      ok: true,
      pairs: [
        ["expand[0]", "a"],
        ["expand[1]", "b"],
      ],
    });
    // Nesting recurses on both sides; an absent item is not sent and keeps the
    // positions of the ones around it.
    expect(
      serializeQueryParam(
        { in: "query", name: "shipping", style: "deepObject" },
        {
          name: "Ada",
          address: { city: "Oslo", line2: null },
          items: [{ price: "p_1", quantity: 2 }, undefined, { price: "p_3" }],
        },
      ),
    ).toEqual({
      ok: true,
      pairs: [
        ["shipping[name]", "Ada"],
        ["shipping[address][city]", "Oslo"],
        ["shipping[items][0][price]", "p_1"],
        ["shipping[items][0][quantity]", "2"],
        ["shipping[items][2][price]", "p_3"],
      ],
    });
    // A scalar under deepObject is the scalar: Stripe's `created` is
    // `anyOf [range object, integer]`, and the integer goes as `created=1`.
    expect(serializeQueryParam({ in: "query", name: "created", style: "deepObject" }, 1)).toEqual({
      ok: true,
      pairs: [["created", "1"]],
    });
  });

  it("serializes form-body fields by their declared encoding, and refuses undeclared nesting", () => {
    // No encoding declared: the plain form reading, exactly as before.
    expect(serializeFormField("email", undefined, "a@x.io")).toEqual({
      ok: true,
      pairs: [["email", "a@x.io"]],
    });
    expect(serializeFormField("tags", undefined, ["x", 2, true])).toEqual({
      ok: true,
      pairs: [
        ["tags", "x"],
        ["tags", "2"],
        ["tags", "true"],
      ],
    });
    // A declared deepObject: Stripe's `metadata[order]=123`, `items[0][price]=…`.
    expect(
      serializeFormField("metadata", { style: "deepObject", explode: true }, { order: 123 }),
    ).toEqual({ ok: true, pairs: [["metadata[order]", "123"]] });
    expect(
      serializeFormField("items", { style: "deepObject" }, [{ price: "p_1", quantity: 1 }]),
    ).toEqual({
      ok: true,
      pairs: [
        ["items[0][price]", "p_1"],
        ["items[0][quantity]", "1"],
      ],
    });
    // The other query styles apply as OpenAPI says they do for a form field.
    expect(serializeFormField("ids", { style: "pipeDelimited" }, ["a", "b"])).toEqual({
      ok: true,
      pairs: [["ids", "a|b"]],
    });
    expect(serializeFormField("point", { style: "form", explode: true }, { x: 1, y: 2 })).toEqual({
      ok: true,
      pairs: [
        ["x", "1"],
        ["y", "2"],
      ],
    });
    // Undeclared nesting is refused, with the fix named: a declared encoding.
    const refused = (encoding: Parameters<typeof serializeFormField>[1], value: unknown) => {
      const result = serializeFormField("f", encoding, value);
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.reason;
    };
    expect(refused(undefined, { a: 1 })).toContain("nested object");
    expect(refused(undefined, { a: 1 })).toContain("encoding");
    expect(refused(undefined, [{ a: 1 }])).toContain("array of objects");
    // A declared style that gives the shape no meaning still refuses.
    expect(refused({ style: "form", explode: true }, [{ a: 1 }])).toContain("array of objects");
    expect(refused({ style: "spaceDelimited" }, { a: 1 })).toContain("no defined encoding");
  });

  it("serializes path and header values in the simple style", () => {
    expect(serializeSimpleParam({ in: "path", name: "id" }, "x y")).toEqual({
      ok: true,
      text: "x y",
    });
    expect(serializeSimpleParam({ in: "path", name: "id" }, ["a", "b"])).toEqual({
      ok: true,
      text: "a,b",
    });
    expect(serializeSimpleParam({ in: "header", name: "h" }, { x: 1, y: 2 })).toEqual({
      ok: true,
      text: "x,1,y,2",
    });
    expect(
      serializeSimpleParam({ in: "header", name: "h", explode: true }, { x: 1, y: 2 }),
    ).toEqual({ ok: true, text: "x=1,y=2" });
    // The encoder is applied per atom, so a path keeps its separating commas
    // literal while every item inside them is still percent-encoded.
    expect(
      serializeSimpleParam({ in: "path", name: "id" }, ["a/b", "c,d"], encodeURIComponent),
    ).toEqual({ ok: true, text: "a%2Fb,c%2Cd" });
  });
});
