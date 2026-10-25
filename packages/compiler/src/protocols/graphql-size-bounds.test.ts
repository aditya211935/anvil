import { buildSchema } from "graphql";
import { describe, expect, it } from "vitest";
import { compile } from "../compile.js";
import { DEFAULT_MAX_SCHEMA_NODES } from "../decycle.js";
import {
  buildSelection,
  countSelectedFields,
  MAX_SELECTION_DEPTH,
  MAX_SELECTION_FIELDS,
  renderSelection,
  type SelectionNode,
} from "./graphql-selection.js";

/**
 * The AIR for a GraphQL operation must stay bounded whatever the SDL's shape.
 *
 * A GraphQL schema is a graph; the selection tree behind one root field is a
 * tree over that graph, and a tree over a graph is exponential in its depth
 * unless something other than depth bounds it. Interfaces and unions multiply
 * it again by their member count at every level. GitHub's `Query.nodes` (an
 * interface with ~250 implementations, whose fields are interfaces) compiled
 * to a 76MB query document and an 8.5MB response schema per operation, and
 * the 309 operations together could not be serialized at all. The fixture
 * below is a small schema with the same shape — wide interfaces whose
 * members reference each other and the interface — and every assertion is a
 * ceiling that held before that regression and must keep holding.
 */

/** A graph as wide and as cyclic as a real one: `members` implementations, `width` fields each. */
function wideCyclicSdl(members: number, width: number): string {
  const names = Array.from({ length: members }, (_, i) => `Thing${i}`);
  const lines: string[] = [
    "interface Node { id: ID! }",
    `union Anything = ${names.join(" | ")}`,
    "type Edge { node: Node! cursor: String! anything: Anything }",
    "type Connection { edges: [Edge!]! nodes: [Node]! total: Int! }",
  ];
  for (const [i, name] of names.entries()) {
    const fields = ["id: ID!"];
    for (let j = 0; j < width; j++) {
      // Every third field points back into the graph: the interface, the
      // union, a connection, or another member — so the tree never bottoms out.
      const kind = j % 4;
      const target =
        kind === 0
          ? "Node"
          : kind === 1
            ? "Anything"
            : kind === 2
              ? "Connection"
              : names[(i + j) % names.length];
      fields.push(`f${j}: ${j % 5 === 4 ? "String" : target}`);
    }
    lines.push(`type ${name} implements Node { ${fields.join(" ")} }`);
  }
  lines.push(
    "type Query {",
    "  node(id: ID!): Node",
    "  nodes(ids: [ID!]!): [Node]!",
    "  everything: [Anything!]!",
    "  connection(first: Int): Connection!",
    `  first: ${names[0]}`,
    "}",
  );
  return lines.join("\n");
}

const SDL = wideCyclicSdl(40, 24);

/** The compiled query document of a GraphQL binding (other protocols carry none). */
function documentOf(binding: unknown): string {
  return binding !== null && typeof binding === "object" && "document" in binding
    ? String((binding as { document: unknown }).document)
    : "";
}

function treeSize(value: unknown): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== "object") continue;
    count++;
    for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push(c);
  }
  return count;
}

describe("a selection is bounded by a field budget, not only by depth", () => {
  const schema = buildSchema(SDL, { assumeValid: true });
  const roots = Object.values(schema.getQueryType()?.getFields() ?? {});

  it("never selects more than the budget plus one type's width, for any root field", () => {
    expect(roots.length).toBeGreaterThan(0);
    const widest = Math.max(
      ...Object.values(schema.getTypeMap())
        .filter((t) => "getFields" in t)
        .map((t) => Object.keys((t as { getFields(): object }).getFields()).length),
    );
    for (const field of roots) {
      const selection = buildSelection(schema, field);
      const selected = countSelectedFields(selection.root);
      expect(selected).toBeLessThanOrEqual(MAX_SELECTION_FIELDS + widest);
      // The budget was needed: unbounded, this graph has tens of thousands of
      // positions within the depth bound alone.
      expect(selection.cuts.some((cut) => cut.reason === "budget")).toBe(true);
      // The rendered document is a few bytes per field — never megabytes.
      const document = renderSelection(selection.root);
      expect(document.length).toBeLessThan(selected * 64 + 4096);
    }
  });

  it("spends the budget breadth-first: nothing is expanded deeper than the shallowest budget cut", () => {
    for (const field of roots) {
      const selection = buildSelection(schema, field);
      const expandedAt: number[] = [];
      const budgetCutAt: number[] = [];
      const visit = (node: SelectionNode, depth: number): void => {
        switch (node.kind) {
          case "leaf":
            return;
          case "cut":
            if (node.reason === "budget") budgetCutAt.push(depth);
            return;
          case "object":
            expandedAt.push(depth);
            for (const f of node.fields) visit(f.node, depth + 1);
            return;
          case "abstract":
            expandedAt.push(depth);
            for (const f of node.fields) visit(f.node, depth + 1);
            for (const m of node.members) {
              if (m.fields === undefined)
                budgetCutAt.push(depth); // cut member (cycle or budget)
              else for (const f of m.fields) visit(f.node, depth + 1);
            }
        }
      };
      visit(selection.root, 0);
      expect(budgetCutAt.length).toBeGreaterThan(0);
      // The root is always expanded (the budget starts full), and the frontier
      // where the budget ran out is at least as deep as every expansion.
      expect(Math.min(...expandedAt)).toBe(0);
      expect(Math.max(...expandedAt)).toBeLessThanOrEqual(Math.min(...budgetCutAt));
      // The root's own fields are all selected, whatever the root type's width.
      if (selection.root.kind === "object") {
        expect(selection.root.fields.length).toBe(
          Object.keys(selection.root.type.getFields()).length,
        );
      }
    }
  });

  it("is deterministic and honours the depth bound as before", () => {
    const [a, b] = roots.map((f) => renderSelection(buildSelection(schema, f).root));
    expect(a).toBe(
      renderSelection(buildSelection(schema, roots[0] as (typeof roots)[number]).root),
    );
    expect(b).toBeDefined();
    expect(MAX_SELECTION_DEPTH).toBe(4);
  });
});

describe("through the whole compiler, every operation's AIR stays small", () => {
  it("bounds the serialized output schema, input schema and query document per operation", async () => {
    const air = await compile({ spec: SDL, serviceId: "wide", sourceUri: "wide.graphql" });
    expect(air.operations.length).toBe(5);
    // The whole document, pretty-printed as `air.json` is: well under a
    // megabyte for a schema whose unbounded selection would be gigabytes.
    const airJson = JSON.stringify(air, null, 2);
    expect(airJson.length).toBeLessThan(1_000_000);
    for (const op of air.operations) {
      const output = JSON.stringify(op.output.schema ?? null);
      const input = JSON.stringify(op.input);
      const document = documentOf(op.sourceRef.binding);
      // Output and input obey the materialization node budget as TREE size,
      // including every reuse of a memoized named schema.
      expect(treeSize(op.output.schema)).toBeLessThanOrEqual(DEFAULT_MAX_SCHEMA_NODES + 1);
      expect(treeSize(op.input)).toBeLessThanOrEqual(DEFAULT_MAX_SCHEMA_NODES + 1);
      // And in bytes: one hop of a bounded selection is tens of KB at most.
      expect(output.length, `${op.id} output`).toBeLessThan(96_000);
      expect(input.length, `${op.id} input`).toBeLessThan(96_000);
      expect(document.length, `${op.id} document`).toBeLessThan(MAX_SELECTION_FIELDS * 64 + 4096);
      expect(document).toContain("__typename");
    }
    // The budget cut is diagnosed, once per operation that needed it, and the
    // compiler never dropped to its generic depth truncation.
    const codes = air.diagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === "graphql_selection_truncated").length).toBe(5);
    expect(codes).not.toContain("schema_depth_truncated");
    // Each such diagnostic counts its cuts by reason, so a budget cut is
    // visible even when the five sampled positions are all cycles.
    for (const d of air.diagnostics.filter((d) => d.code === "graphql_selection_truncated")) {
      expect(d.message).toMatch(/\d+ at the field budget/);
      expect(d.message).toContain(`${MAX_SELECTION_FIELDS} fields in total`);
    }
  });

  it("stays bounded as the graph gets wider: twice the members, same ceilings", async () => {
    const wider = await compile({
      spec: wideCyclicSdl(80, 24),
      serviceId: "wider",
      sourceUri: "wider.graphql",
    });
    for (const op of wider.operations) {
      expect(treeSize(op.output.schema)).toBeLessThanOrEqual(DEFAULT_MAX_SCHEMA_NODES + 1);
      expect(JSON.stringify(op.output.schema ?? null).length).toBeLessThan(96_000);
      expect(documentOf(op.sourceRef.binding).length).toBeLessThan(
        MAX_SELECTION_FIELDS * 64 + 4096,
      );
    }
    expect(JSON.stringify(wider, null, 2).length).toBeLessThan(1_000_000);
  });
});
