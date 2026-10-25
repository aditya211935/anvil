import { type JsonSchema, materializeSchemaBranches } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  describeExampleProblem,
  exampleFromSchema,
  exampleFromSchemaReport,
} from "./mock-example.js";

/**
 * Every rule here is pinned against the SAME validator the generated MCP
 * server runs — zod's JSON Schema importer over the materialized schema — so a
 * synthesized example that passes here is one a tool call with it will not be
 * refused for. The shapes come from real corpus specs (Intercom, Confluence,
 * Stripe) that the loopback self-test tripped over.
 */
const accepts = (schema: JsonSchema, value: unknown) =>
  z
    .fromJSONSchema(materializeSchemaBranches(schema) as Parameters<typeof z.fromJSONSchema>[0])
    .safeParse(value).success;

describe("exampleFromSchema honors the string contract", () => {
  it.each([
    ["uuid", /^[0-9a-f-]{36}$/],
    ["date-time", /^\d{4}-\d{2}-\d{2}T/],
    ["date", /^\d{4}-\d{2}-\d{2}$/],
    ["time", /^\d{2}:\d{2}:\d{2}Z$/],
    ["duration", /^P/],
    ["email", /@/],
    ["uri", /^https:\/\//],
    ["hostname", /\./],
    ["ipv4", /^\d+\.\d+\.\d+\.\d+$/],
    ["ipv6", /:/],
    ["base64", /=$/],
  ])("synthesizes a %s that zod accepts", (format, shape) => {
    const schema = { type: "string", format };
    const value = exampleFromSchema(schema);
    expect(value).toMatch(shape);
    expect(accepts(schema, value)).toBe(true);
  });

  it("satisfies pattern, minLength and maxLength together", () => {
    const schema = { type: "string", pattern: "^[A-Z]{3}-[0-9]{2}$" };
    expect(accepts(schema, exampleFromSchema(schema))).toBe(true);
    const bounded = { type: "string", minLength: 3, maxLength: 5 };
    expect(exampleFromSchema(bounded)).toBe("examp");
    expect(accepts(bounded, exampleFromSchema(bounded))).toBe(true);
  });

  it("honors enum and const before anything else", () => {
    expect(exampleFromSchema({ type: "string", enum: ["alpha", "beta"] })).toBe("alpha");
    expect(exampleFromSchema({ type: "string", const: "locked", format: "uuid" })).toBe("locked");
    expect(exampleFromSchema({ enum: [null, 7] })).toBe(7);
  });

  it("drops a declared example the schema itself refuses (Intercom's ObjectId on a uuid field)", () => {
    // Intercom: `format: uuid` with a 24-character ObjectId as the example.
    // The example is a lie the tool would refuse; the format alone synthesizes.
    const schema = { type: "string", format: "uuid", example: "536e564f316c83104c000020" };
    const value = exampleFromSchema(schema);
    expect(value).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(accepts(schema, value)).toBe(true);
    // A declared example the schema admits is still preferred, as before.
    expect(exampleFromSchema({ type: "string", format: "email", example: "a@b.co" })).toBe(
      "a@b.co",
    );
    expect(
      exampleFromSchema({ type: "string", pattern: "^x+$", example: "yyy", examples: ["xx"] }),
    ).toBe("xx");
    expect(exampleFromSchema({ type: "integer", minimum: 5, example: 2 })).toBe(5);
  });

  it("reports a string contract no value satisfies instead of inventing one", () => {
    // Intercom's real `from.id`: a UUID is 36 characters, the schema allows 24.
    const schema = { type: "string", format: "uuid", minLength: 24, maxLength: 24 };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toBeNull();
    expect(problems).toEqual([
      {
        path: "",
        kind: "unsatisfiable",
        detail: "no string satisfies format uuid, minLength 24, maxLength 24",
      },
    ]);
  });
});

describe("exampleFromSchema honors numeric bounds", () => {
  it.each([
    [{ type: "integer" }, 1],
    [{ type: "number" }, 1],
    [{ type: "integer", minimum: 5, maximum: 6 }, 5],
    [{ type: "integer", maximum: -5 }, -5],
    [{ type: "integer", exclusiveMinimum: 5 }, 6],
    [{ type: "integer", minimum: 5, exclusiveMinimum: true }, 6],
    [{ type: "integer", minimum: 1.5 }, 2],
    [{ type: "integer", multipleOf: 7 }, 7],
    [{ type: "integer", minimum: 10, maximum: 20, multipleOf: 5 }, 10],
    [{ type: "number", minimum: 2.5 }, 2.5],
    [{ type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 }, 0.5],
    [{ type: "number", exclusiveMaximum: 1 }, 0],
    [{ type: "number", minimum: 0.1, multipleOf: 0.25 }, 1],
    [{ type: "number", minimum: 0.1, maximum: 0.6, multipleOf: 0.25 }, 0.25],
  ])("%j → %s", (schema, expected) => {
    expect(exampleFromSchema(schema)).toBe(expected);
    expect(accepts(schema, expected)).toBe(true);
  });

  it("reports bounds that admit no value", () => {
    const { value, problems } = exampleFromSchemaReport({
      type: "integer",
      exclusiveMinimum: 5,
      exclusiveMaximum: 6,
    });
    expect(value).toBeNull();
    expect(problems[0]).toMatchObject({ kind: "unsatisfiable" });
    expect(problems[0]?.detail).toContain("exclusiveMinimum 5");
  });
});

describe("exampleFromSchema honors array bounds and type lists", () => {
  it("fills minItems with distinct members when uniqueItems demands it", () => {
    const schema = { type: "array", items: { type: "string" }, minItems: 2, uniqueItems: true };
    const value = exampleFromSchema(schema);
    expect(value).toEqual(["example", "example-1"]);
    expect(accepts(schema, value)).toBe(true);
    const enums = {
      type: "array",
      items: { type: "string", enum: ["x", "y", "z"] },
      minItems: 3,
      uniqueItems: true,
    };
    expect(exampleFromSchema(enums)).toEqual(["x", "y", "z"]);
    const ints = {
      type: "array",
      items: { type: "integer", minimum: 3 },
      minItems: 2,
      uniqueItems: true,
    };
    expect(exampleFromSchema(ints)).toEqual([3, 4]);
    expect(accepts(ints, exampleFromSchema(ints))).toBe(true);
  });

  it("respects maxItems, including an empty list", () => {
    expect(exampleFromSchema({ type: "array", items: { type: "string" }, maxItems: 0 })).toEqual(
      [],
    );
    expect(
      exampleFromSchema({ type: "array", items: { type: "string" }, minItems: 3, maxItems: 3 }),
    ).toHaveLength(3);
  });

  it("reports uniqueItems the items schema cannot supply enough distinct values for", () => {
    const { problems } = exampleFromSchemaReport({
      type: "array",
      items: { type: "boolean" },
      minItems: 3,
      uniqueItems: true,
    });
    expect(problems[0]).toMatchObject({ kind: "unsatisfiable" });
    expect(problems[0]?.detail).toContain("uniqueItems");
  });

  it("teaches the non-null member of a type list", () => {
    const schema = { type: ["string", "null"] };
    expect(exampleFromSchema(schema)).toBe("example");
    expect(accepts(schema, "example")).toBe(true);
    expect(exampleFromSchema({ type: ["null", "integer"], minimum: 4 })).toBe(4);
  });
});

describe("exampleFromSchema keeps objects valid for zod", () => {
  it("omits an optional property it cannot synthesize instead of sending null", () => {
    // zod reads optional as ABSENT; `nullable` alone does not admit null, and an
    // empty `enum`/`anyOf` admits nothing at all (Stripe's budget-truncated lists).
    const schema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        tax_rates: { anyOf: [] },
        kind: { type: "string", enum: [] },
        legacy: { type: "string", nullable: true, format: "uuid", maxLength: 4 },
      },
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({ name: "example" });
    expect(accepts(schema, value)).toBe(true);
    expect(problems.map((p) => p.path).sort()).toEqual(["kind", "legacy", "tax_rates"]);
    expect(problems.every((p) => p.kind === "unsatisfiable")).toBe(true);
  });

  it("keeps a required property it cannot synthesize so the refusal names it", () => {
    const schema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", format: "uuid", maxLength: 24 } },
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({ id: null });
    expect(problems).toEqual([
      {
        path: "id",
        kind: "unsatisfiable",
        detail: "no string satisfies format uuid, maxLength 24",
      },
    ]);
  });

  it("reports a memoized subschema's problem at every position it is reached from", () => {
    const shared = { type: "string", enum: [] };
    const schema = {
      type: "object",
      required: ["a", "b"],
      properties: { a: shared, b: { type: "object", required: ["c"], properties: { c: shared } } },
    };
    const { problems } = exampleFromSchemaReport(schema);
    expect(problems.map((p) => p.path)).toEqual(["a", "b.c"]);
  });
});

describe("exampleFromSchema picks exactly one oneOf alternative", () => {
  it("takes the first alternative when its witness matches it alone", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["card"],
          additionalProperties: false,
          properties: { card: { type: "string" } },
        },
        {
          type: "object",
          required: ["bank"],
          additionalProperties: false,
          properties: { bank: { type: "string" } },
        },
      ],
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({ card: "example" });
    expect(problems).toEqual([]);
    expect(accepts(schema, value)).toBe(true);
  });

  it("falls through to a later alternative when only that one has a witness of its own", () => {
    // {a} matches both alternatives; {a, b} matches the open one alone.
    const schema = {
      oneOf: [
        { type: "object", additionalProperties: false, properties: { a: { type: "string" } } },
        { type: "object", properties: { a: { type: "string" }, b: { type: "string" } } },
      ],
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({ a: "example", b: "example" });
    expect(problems).toEqual([]);
    expect(accepts(schema, value)).toBe(true);
  });

  it("discriminates by const/enum literals (discriminator-style unions)", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: ["admin"] }, admin_id: { type: "string" } },
        },
        {
          type: "object",
          required: ["type"],
          properties: { type: { type: "string", enum: ["user"] }, email: { type: "string" } },
        },
      ],
    };
    const value = exampleFromSchema(schema);
    expect(value).toEqual({ type: "admin", admin_id: "example" });
    expect(accepts(schema, value)).toBe(true);
  });

  it("reports a oneOf whose alternatives cannot be told apart and names the manifest remedy", () => {
    // Confluence's page body: oneOf[PageBodyWrite, PageNestedBodyWrite], both
    // open objects, so every value matches both and zod's xor refuses all.
    const body = {
      oneOf: [
        {
          title: "PageBodyWrite",
          type: "object",
          properties: {
            representation: { type: "string", enum: ["storage"] },
            value: { type: "string" },
          },
        },
        {
          title: "PageNestedBodyWrite",
          type: "object",
          properties: { storage: { type: "object" } },
        },
      ],
    };
    const schema = {
      type: "object",
      required: ["title", "body"],
      properties: { title: { type: "string" }, body },
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({
      title: "example",
      body: { representation: "storage", value: "example" },
    });
    expect(accepts(schema, value)).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ path: "body", kind: "indiscriminable_union" });
    expect(problems[0]?.detail).toContain("0: PageBodyWrite, 1: PageNestedBodyWrite");
    const line = describeExampleProblem({
      ...(problems[0] as (typeof problems)[0]),
      path: "body.body",
    });
    expect(line).toContain("params: { body: { one_of: <component name or index> } }");
  });

  it("says when a problem lies out of a manifest params entry's reach", () => {
    const nested = describeExampleProblem({
      path: "body.from.id",
      kind: "unsatisfiable",
      detail: "no string satisfies format uuid, maxLength 24",
    });
    expect(nested).toContain("body.from.id: no string satisfies format uuid, maxLength 24");
    expect(nested).toContain("out of a manifest params entry's reach");
    const whole = describeExampleProblem({
      path: "body",
      kind: "indiscriminable_union",
      detail: "x",
    });
    expect(whole).toContain("params: { body: { one_of: <component name or index> } }");
    const param = describeExampleProblem({
      path: "body_format",
      kind: "indiscriminable_union",
      detail: "x",
    });
    expect(param).toContain("params: { body_format: { one_of: <component name or index> } }");
  });

  it("still selects one required-only branch over a shared properties map", () => {
    const schema = {
      type: "object",
      properties: { page_id: { type: "string" }, database_id: { type: "string" } },
      oneOf: [{ required: ["page_id"] }, { required: ["database_id"] }],
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual({ page_id: "example" });
    expect(problems).toEqual([]);
    expect(accepts(schema, value)).toBe(true);
  });
});

describe("exampleFromSchema picks a satisfiable anyOf alternative", () => {
  it("takes the first alternative its own witness satisfies (Stripe's list-or-empty-string)", () => {
    const schema = {
      anyOf: [
        { type: "array", items: { type: "string", enum: ["x", "y"] } },
        { type: "string", enum: [""] },
      ],
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toEqual(["x"]);
    expect(problems).toEqual([]);
    expect(accepts(schema, value)).toBe(true);
  });

  it("skips an alternative no value satisfies and keeps only the chosen one's problems", () => {
    // Stripe after budget truncation: the list's item enum was emptied, so the
    // list admits nothing; the empty string still does.
    const schema = {
      anyOf: [
        { type: "array", items: { type: "string", enum: [] } },
        { type: "string", enum: [""] },
      ],
    };
    const { value, problems } = exampleFromSchemaReport(schema);
    expect(value).toBe("");
    expect(problems).toEqual([]);
    expect(accepts(schema, value)).toBe(true);
  });

  it("reports an anyOf none of whose alternatives admit a value", () => {
    const { value, problems } = exampleFromSchemaReport({
      anyOf: [
        { type: "string", enum: [] },
        { type: "integer", minimum: 2, maximum: 1 },
      ],
    });
    expect(value).toBeNull();
    expect(problems.at(-1)).toMatchObject({ kind: "unsatisfiable", path: "" });
    expect(problems.at(-1)?.detail).toContain(
      "no synthesized value satisfies any anyOf alternative",
    );
  });
});
