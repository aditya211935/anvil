import type { Diagnostic } from "@anvil/air";
import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { adaptGraphql } from "./graphql.js";
import { MAX_SELECTION_DEPTH, TYPENAME_ONLY_SCHEMA } from "./graphql-selection.js";

/**
 * The compiled query document and the response schema are two projections of
 * one selection tree. Every test here holds the two against each other: what
 * the document asks for is what the schema promises, and nothing more.
 */

type Op = Record<string, unknown>;
const opAt = (doc: ReturnType<typeof adaptGraphql>, path: string): Op =>
  doc.paths?.[path]?.post as Op;
const documentOf = (op: Op): string =>
  (op["x-anvil-wire-binding"] as { document: string }).document;
const responseOf = (op: Op): Record<string, unknown> =>
  (
    op.responses as Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>
  )["200"]?.content["application/json"]?.schema as Record<string, unknown>;
const lower = (sdl: string) => {
  const diagnostics: Diagnostic[] = [];
  const doc = adaptGraphql(sdl, "svc", diagnostics);
  return {
    doc,
    diagnostics,
    schemas: doc.components?.schemas as Record<string, Record<string, unknown>>,
  };
};

describe("unions and interfaces are selected through inline fragments", () => {
  const SDL = `
    type Product { id: ID! name: String! }
    type Shop { id: ID! title: String! }
    union SearchResult = Product | Shop
    interface Node { id: ID! }
    type Folder implements Node { id: ID! name: String! }
    type File implements Node { id: ID! size: Int! }
    interface Orphan { label: String! }
    type Query {
      search(q: String): [SearchResult!]!
      node(id: ID!): Node
      orphan: Orphan
    }
  `;
  const { doc, diagnostics, schemas } = lower(SDL);

  it("asks for every union member's fields, not just __typename", () => {
    const search = opAt(doc, "/graphql/Query/search");
    expect(documentOf(search)).toBe(
      "query Anvil_Search($q: String) { search(q: $q) " +
        "{ __typename ... on Product { id name } ... on Shop { id title } } }",
    );
    // The schema promised a oneOf of the members all along; now the document
    // delivers it, so the response schema can keep pointing at the union.
    expect(responseOf(search)).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/SearchResult" },
    });
    expect(schemas.SearchResult).toEqual({
      oneOf: [{ $ref: "#/components/schemas/Product" }, { $ref: "#/components/schemas/Shop" }],
    });
  });

  it("selects an interface's own fields once, then each implementation's extra fields", () => {
    const node = opAt(doc, "/graphql/Query/node");
    expect(documentOf(node)).toBe(
      "query Anvil_Node($id: ID!) { node(id: $id) " +
        "{ __typename id ... on Folder { name } ... on File { size } } }",
    );
    // What comes back is one implementation's fields, so that is what the
    // interface's component says — not the interface's fields alone.
    expect(schemas.Node).toEqual({
      oneOf: [{ $ref: "#/components/schemas/Folder" }, { $ref: "#/components/schemas/File" }],
    });
  });

  it("falls back to an interface's own fields when nothing implements it", () => {
    const orphan = opAt(doc, "/graphql/Query/orphan");
    expect(documentOf(orphan)).toBe("query Anvil_Orphan { orphan { label } }");
    expect(schemas.Orphan).toMatchObject({ type: "object", properties: { label: {} } });
    expect(diagnostics).toEqual([]);
  });
});

describe("a field with required arguments is absent from document and schema alike", () => {
  const SDL = `
    enum Status { OPEN CLOSED }
    type Shipment { id: ID! }
    type Event { at: String! }
    type Order {
      id: ID!
      shipments(status: Status!): [Shipment!]!
      history(first: Int = 10): [Event!]
      note(locale: String): String
    }
    type Query { order(id: ID!): Order  orders: [Order!]! }
  `;
  const { doc, diagnostics, schemas } = lower(SDL);

  it("keeps fields whose arguments are optional or defaulted, drops the rest", () => {
    const order = opAt(doc, "/graphql/Query/order");
    expect(documentOf(order)).toBe(
      "query Anvil_Order($id: ID!) { order(id: $id) { id history { at } note } }",
    );
    // Schema equals wire: the component no longer lists `shipments`.
    expect(Object.keys(schemas.Order?.properties as object)).toEqual(["id", "history", "note"]);
    expect(responseOf(order)).toEqual({ $ref: "#/components/schemas/Order" });
  });

  it("says so once per operation, naming the field and its arguments", () => {
    const omitted = diagnostics.filter((d) => d.code === "graphql_field_omitted_required_args");
    expect(omitted.map((d) => d.path)).toEqual(["Query.order", "Query.orders"]);
    for (const d of omitted) {
      expect(d.level).toBe("warning");
      expect(d.message).toContain("Order.shipments(status: Status!)");
      expect(d.message).not.toContain("history");
    }
  });
});

/** The positional component a `$ref` points at, with its name. */
const positionalOf = (
  schemas: Record<string, Record<string, unknown>>,
  schema: Record<string, unknown>,
  type: string,
): { name: string; body: Record<string, unknown> } => {
  const name = String(schema.$ref).replace("#/components/schemas/", "");
  expect(name).toMatch(new RegExp(`^${type}_at_[0-9a-f]{8}$`));
  const body = schemas[name];
  expect(body).toBeDefined();
  return { name, body: body as Record<string, unknown> };
};

describe("where the selection stops, the schema stops promising", () => {
  it("cuts a cycle to __typename and renders that position as TypenameOnly", () => {
    const { doc, diagnostics, schemas } = lower(`
      type Node { id: ID! parent: Node }
      type Query { node: Node }
    `);
    const node = opAt(doc, "/graphql/Query/node");
    expect(documentOf(node)).toBe("query Anvil_Node { node { id parent { __typename } } }");
    // The component describes the type; this position returns less than the
    // type, so the schema points at a positional component of its own, whose
    // cut field points at the stand-in.
    const { body } = positionalOf(schemas, responseOf(node), "Node");
    expect(body).toEqual({
      type: "object",
      title: "Node",
      properties: {
        id: { type: "string", description: "GraphQL ID" },
        parent: { $ref: `#/components/schemas/${TYPENAME_ONLY_SCHEMA}` },
      },
      required: ["id"],
    });
    expect(schemas[TYPENAME_ONLY_SCHEMA]).toMatchObject({
      type: "object",
      properties: { __typename: { type: "string" } },
      required: ["__typename"],
    });
    const cut = diagnostics.filter((d) => d.code === "graphql_selection_truncated");
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ level: "warning", path: "Query.node" });
    expect(cut[0]?.message).toContain("node.parent (cycle back to Node)");
  });

  it("cuts at the depth budget and names the position", () => {
    const { doc, diagnostics, schemas } = lower(`
      type A { b: B }
      type B { c: C }
      type C { d: D }
      type D { e: E }
      type E { x: Int }
      type Query { a: A }
    `);
    expect(MAX_SELECTION_DEPTH).toBe(4);
    expect(documentOf(opAt(doc, "/graphql/Query/a"))).toBe(
      "query Anvil_A { a { b { c { d { e { __typename } } } } } }",
    );
    const cut = diagnostics.find((d) => d.code === "graphql_selection_truncated");
    expect(cut?.message).toContain("a.b.c.d.e (depth budget of 4 reached at E)");
    // Every position above the cut is non-canonical, so each is a positional
    // component — a `$ref` chain down to the stand-in, never inline structure
    // (which the materialization bounds could not see) and never a fallback
    // to a type's component (which would promise the fields the cut dropped).
    let schema = responseOf(opAt(doc, "/graphql/Query/a"));
    for (const type of ["A", "B", "C", "D"]) {
      const { body } = positionalOf(schemas, schema, type);
      expect(body).toMatchObject({ type: "object", title: type });
      const [field] = Object.values(body.properties as Record<string, Record<string, unknown>>);
      schema = field as Record<string, unknown>;
    }
    expect(schema).toEqual({ $ref: `#/components/schemas/${TYPENAME_ONLY_SCHEMA}` });
  });

  it("names a positional component for its type and content, deduplicated across operations", () => {
    const { doc, schemas } = lower(`
      type Node { id: ID! parent: Node }
      type Query { node: Node  other: Node  nodes: [Node!]! }
    `);
    const first = positionalOf(schemas, responseOf(opAt(doc, "/graphql/Query/node")), "Node");
    const second = positionalOf(schemas, responseOf(opAt(doc, "/graphql/Query/other")), "Node");
    const list = responseOf(opAt(doc, "/graphql/Query/nodes")) as {
      items: Record<string, unknown>;
    };
    // The same selection at three positions is one component.
    expect(second.name).toBe(first.name);
    expect(list.items).toEqual({ $ref: `#/components/schemas/${first.name}` });
    expect(Object.keys(schemas).filter((n) => n.startsWith("Node_at_"))).toEqual([first.name]);
    // The SDL's own types are untouched beside it.
    expect(schemas.Node).toMatchObject({ type: "object", properties: { id: {}, parent: {} } });
  });

  it("registers the stand-in only when something was cut, and never over a user type", () => {
    const clean = lower("type P { id: ID! } type Query { p: P }");
    expect(clean.schemas[TYPENAME_ONLY_SCHEMA]).toBeUndefined();
    expect(clean.diagnostics).toEqual([]);
    expect(Object.keys(clean.schemas)).toEqual(["P"]);

    const clash = lower(`
      type TypenameOnly { x: Int }
      type Node { id: ID! parent: Node }
      type Query { node: Node  t: TypenameOnly }
    `);
    expect(clash.schemas.TypenameOnly).toMatchObject({ properties: { x: {} } });
    expect(clash.schemas.Anvil_TypenameOnly).toMatchObject({ properties: { __typename: {} } });
    const { body } = positionalOf(
      clash.schemas,
      responseOf(opAt(clash.doc, "/graphql/Query/node")),
      "Node",
    );
    expect((body.properties as Record<string, unknown>).parent).toEqual({
      $ref: "#/components/schemas/Anvil_TypenameOnly",
    });
  });

  it("cuts a member that would re-enter a type, keeping the fragment legal", () => {
    const { doc } = lower(`
      interface Node { id: ID! }
      type Folder implements Node { id: ID! entries: [Node!]! }
      type File implements Node { id: ID! size: Int! }
      type Query { folder: Folder }
    `);
    // folder(0) → entries: Node(1) → Folder is an ancestor, so its fragment
    // carries only __typename; File is fresh and gets its fields.
    expect(documentOf(opAt(doc, "/graphql/Query/folder"))).toBe(
      "query Anvil_Folder { folder { id entries " +
        "{ __typename id ... on Folder { __typename } ... on File { size } } } }",
    );
  });
});

describe("through the whole compiler", () => {
  const SDL = `
    type Customer { id: ID! name: String! orders: [Order!]! }
    type Order { id: ID! lines: [Line!]! customer: Customer! }
    type Line { sku: String! product: Product! }
    type Product { id: ID! category: Category }
    type Category { id: ID! products: [Product!]! }
    type Query { customer(id: ID!): Customer }
  `;

  it("stays inside the shared schema bounds: no anonymous-depth truncation, no missing binding", async () => {
    const air = await compile({ spec: SDL, serviceId: "shop", sourceUri: "shop.graphql" });
    const codes = air.diagnostics.map((d) => d.code);
    expect(codes).toContain("graphql_selection_truncated");
    expect(codes).not.toContain("schema_depth_truncated");
    const op = air.operations.find((o) => o.sourceRef.operationId === "customer");
    expect(op?.sourceRef.binding?.protocol).toBe("graphql");
    // The document carries the cut: `customer.orders[].customer` is the cycle.
    const binding = op?.sourceRef.binding;
    expect(binding && "document" in binding ? binding.document : "").toContain(
      "customer { __typename }",
    );
    // The agent-facing projection is the position's own fields one hop deep,
    // exactly as a REST operation's is: the nested position is a typed stub,
    // not the type's component (which would promise the cut fields) and not
    // inline structure (which the materialization bound could not see).
    const output = op?.output.schema as Record<string, unknown>;
    expect(output).toMatchObject({ type: "object", title: "Customer" });
    const orders = (output.properties as Record<string, Record<string, unknown>>).orders ?? {};
    const items = (orders.items ?? {}) as Record<string, unknown>;
    expect(items).toMatchObject({ type: "object" });
    expect(String(items.description)).toMatch(
      /^A 'Order_at_[0-9a-f]{8}' object; nested one level deep/,
    );
    expect(items.properties).toBeUndefined();
  });

  it("deepens with the profile's ref depth, like every other protocol", async () => {
    const { materializeWithin } = await import("../schema-bounds.js");
    const diagnostics: Diagnostic[] = [];
    const doc = adaptGraphql(SDL, "shop", diagnostics);
    const schemas = doc.components?.schemas as Record<string, unknown>;
    const response = responseOf(opAt(doc, "/graphql/Query/customer"));
    const deeper = materializeWithin(response, schemas, {
      maxRefDepth: 3,
      maxSchemaNodes: 4000,
      inheritAllOf: false,
      fitToBudget: false,
    }).schema as Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    // Customer → Order → the stand-in is three hops: the order's own selection
    // is visible, and the cycle position resolves to __typename only.
    const order = deeper.properties?.orders?.items as Record<string, Record<string, unknown>>;
    expect(order).toMatchObject({ type: "object", title: "Order" });
    expect(order.properties?.customer).toMatchObject({
      properties: { __typename: { type: "string" } },
      required: ["__typename"],
    });
  });
});
