/**
 * The selection tree behind one GraphQL root field.
 *
 * The compiled query document and the operation's response schema used to be
 * computed by two independent walks over the SDL, and they disagreed: a union
 * was selected as `{ __typename }` while the schema promised the members'
 * fields; a field that takes required arguments was skipped on the wire and
 * kept in the schema; a depth cut was silent. Both artifacts now derive from
 * this one tree, so the schema can only describe what the document asks for.
 *
 * The tree is positional. A GraphQL schema is a graph, so the same type reached
 * at different depths, or through a cycle, gets a different selection — and
 * the schema for that position has to say so rather than pointing at the
 * type's full component. `responseSchemaFor` renders a node as a `$ref` to the
 * type's component only when the node's whole subtree is the type's canonical
 * selection; anything else becomes a *positional component* of its own (see
 * `SchemaRegistry`), referenced with `$ref` like a vendor type, so the shared
 * materialization bounds govern it exactly as they govern every REST schema.
 *
 * The tree is bounded on three axes, and every bound is a *cut*: the document
 * selects `__typename` there, the schema says so, and the diagnostic names the
 * position. Depth (`MAX_SELECTION_DEPTH`) stops the merely-deep case; the
 * per-path visited set stops cycles; and `MAX_SELECTION_FIELDS` stops the
 * *wide* case that the first two cannot see. Depth alone is no bound on size:
 * a tree of depth 4 over types with 30 fields is 30^4 positions, and an
 * interface or union multiplies that again by its member count at every level
 * it appears. GitHub's `Query.nodes` returns `[Node]`, an interface with some
 * 250 implementations whose fields are themselves interfaces (`Actor`,
 * `RepositoryOwner`, …) — under depth and cycle bounds alone its selection
 * rendered to a 76MB query document and an 8.5MB response schema, and the 300
 * operations together could not be serialized. The tree is therefore filled
 * breadth-first against the field budget, so the budget goes to the shallow
 * fields a caller reads first and the cut, when it comes, is at the deepest
 * frontier rather than wherever a depth-first walk happened to be.
 */
import { createHash } from "node:crypto";
import {
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLOutputType,
  type GraphQLSchema,
  type GraphQLUnionType,
  getNamedType,
  isEnumType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
} from "graphql";

type JsonSchemaLike = Record<string, unknown>;

/** How deep a selection set may go before it stops descending.
 *
 *  A GraphQL schema is a graph, not a tree — `Order.customer.orders` is legal
 *  and infinite. Cycles are cut by the visited-set below; this bounds the
 *  merely-deep case, where a legitimate schema would otherwise produce a
 *  selection set nobody wants to read or transfer. */
export const MAX_SELECTION_DEPTH = 4;

/**
 * How many fields one root field's selection may hold in total, across every
 * level and every inline fragment.
 *
 * This is the bound on the *size* of what one call asks for and promises back;
 * `MAX_SELECTION_DEPTH` only bounds how far down it reaches. The tree is filled
 * breadth-first (see `buildSelection`), so the budget is spent on the fields
 * nearest the root — the ones a caller reads — and every position left over is
 * cut to `__typename` with a `budget` reason. An object's fields are selected
 * as a unit: the last expansion that starts may overrun the budget by that one
 * type's field count, so a wide type at the frontier is either selected whole
 * or cut whole, never half-listed (a half-listed object would need its own
 * schema to say which half).
 *
 * Measured on GitHub's real schema: with no field budget the 309 operations
 * compiled to 258MB of AIR; the whole-source compiles of GitHub and Linear
 * must stay within their corpus size budgets (tools/corpus/baseline.json), and
 * a query document of a few hundred fields is also what a GraphQL server will
 * actually accept — GitHub rejects documents past its node and complexity
 * limits outright.
 */
export const MAX_SELECTION_FIELDS = 300;

/** The component that stands in wherever the selection stops. */
export const TYPENAME_ONLY_SCHEMA = "TypenameOnly";

/** Why a selection stops at a node. */
type SelectionCut = "depth" | "cycle" | "budget";

interface SelectionField {
  name: string;
  /** The field's declared (possibly wrapped) type; list wrappers become arrays. */
  type: GraphQLOutputType;
  description: string | null | undefined;
  node: SelectionNode;
}

interface SelectionMember {
  type: GraphQLObjectType;
  /** The member's own fields (those not on the interface), or undefined when cut. */
  fields: SelectionField[] | undefined;
}

export type SelectionNode =
  | { kind: "leaf"; type: GraphQLNamedType }
  | { kind: "object"; type: GraphQLObjectType | GraphQLInterfaceType; fields: SelectionField[] }
  | {
      kind: "abstract";
      type: GraphQLUnionType | GraphQLInterfaceType;
      /** An interface's own fields, selected once; empty for a union. */
      fields: SelectionField[];
      members: SelectionMember[];
    }
  | { kind: "cut"; type: GraphQLNamedType; reason: SelectionCut };

export interface SelectionCutRecord {
  path: string;
  type: string;
  reason: SelectionCut;
}

export interface Selection {
  root: SelectionNode;
  /** `Type.field(arg: T!, …)` for every field left out for taking required arguments. */
  omittedRequiredArgs: string[];
  cuts: SelectionCutRecord[];
}

/**
 * A field that takes a required argument cannot be selected without inventing
 * a value for it, and inventing values is Anvil making up a request. Such a
 * field is left out of the document and of the response schema alike.
 */
export function requiresArguments(field: GraphQLField<unknown, unknown>): boolean {
  return field.args.some((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined);
}

interface Findings {
  omitted: Map<string, string>;
  cuts: SelectionCutRecord[];
}

/**
 * One selection under construction. Composite positions are not expanded
 * where they are found: each is placed as a provisional node and its expansion
 * is queued, so the queue drains level by level (a FIFO of expansions whose
 * children are enqueued as they run is a breadth-first walk) and `remaining`
 * is spent on the shallowest positions first.
 */
interface Builder {
  schema: GraphQLSchema;
  findings: Findings;
  /** Field positions the tree may still take; an expansion that starts at zero or below is cut. */
  remaining: number;
  queue: (() => void)[];
}

/** Where a node goes once it is decided: a field's `node`, or the root. */
type Place = (node: SelectionNode) => void;

type ObjectNode = Extract<SelectionNode, { kind: "object" }>;
type AbstractNode = Extract<SelectionNode, { kind: "abstract" }>;

export function buildSelection(
  schema: GraphQLSchema,
  field: GraphQLField<unknown, unknown>,
  maxFields = MAX_SELECTION_FIELDS,
): Selection {
  const builder: Builder = {
    schema,
    findings: { omitted: new Map(), cuts: [] },
    remaining: maxFields,
    queue: [],
  };
  const named = getNamedType(field.type);
  let root: SelectionNode = { kind: "leaf", type: named };
  select(named, 0, new Set(), field.name, builder, (node) => {
    root = node;
  });
  // Drain in order. Expansions enqueue their children behind every expansion
  // already waiting, so depth never decreases along the queue.
  for (let i = 0; i < builder.queue.length; i++) (builder.queue[i] as () => void)();
  const { findings } = builder;
  return { root, omittedRequiredArgs: [...findings.omitted.values()], cuts: findings.cuts };
}

function select(
  type: GraphQLNamedType,
  depth: number,
  seen: ReadonlySet<string>,
  path: string,
  builder: Builder,
  place: Place,
): void {
  if (isScalarType(type) || isEnumType(type)) {
    place({ kind: "leaf", type });
    return;
  }
  if (!isObjectType(type) && !isInterfaceType(type) && !isUnionType(type)) {
    place({ kind: "leaf", type });
    return;
  }
  if (depth >= MAX_SELECTION_DEPTH) {
    place(cut(type, "depth", path, builder.findings));
    return;
  }
  if (seen.has(type.name)) {
    place(cut(type, "cycle", path, builder.findings));
    return;
  }
  const nested = new Set(seen).add(type.name);

  const possible = isObjectType(type) ? [] : builder.schema.getPossibleTypes(type);
  // An interface nothing implements is selectable only through its own fields.
  if (isObjectType(type) || (isInterfaceType(type) && possible.length === 0)) {
    const node: ObjectNode = { kind: "object", type, fields: [] };
    place(node);
    builder.queue.push(() => {
      if (builder.remaining <= 0) {
        place(cut(type, "budget", path, builder.findings));
        return;
      }
      node.fields = fieldsOf(type, depth, nested, path, builder);
    });
    return;
  }

  const abstract: AbstractNode = { kind: "abstract", type, fields: [], members: [] };
  place(abstract);
  // One expansion for the interface's own fields and every member's: they are
  // all fields of the same position, at the same depth, and a member whose
  // fragment the budget no longer covers is cut to `__typename` exactly as a
  // member that would re-enter a type is.
  builder.queue.push(() => {
    if (builder.remaining <= 0) {
      place(cut(type, "budget", path, builder.findings));
      return;
    }
    const own = isInterfaceType(type) ? fieldsOf(type, depth, nested, path, builder) : [];
    const inherited = new Set(own.map((f) => f.name));
    abstract.fields = own;
    abstract.members = possible.map((member) => {
      const memberPath = `${path}<${member.name}>`;
      if (nested.has(member.name)) {
        builder.findings.cuts.push({ path: memberPath, type: member.name, reason: "cycle" });
        return { type: member, fields: undefined };
      }
      if (builder.remaining <= 0) {
        builder.findings.cuts.push({ path: memberPath, type: member.name, reason: "budget" });
        return { type: member, fields: undefined };
      }
      const memberSeen = new Set(nested).add(member.name);
      return {
        type: member,
        fields: fieldsOf(member, depth, memberSeen, memberPath, builder, inherited),
      };
    });
  });
}

/**
 * Select a type's fields at one position, charging the budget for each, and
 * queue the expansion of every composite field. Must only be called with
 * budget remaining — the caller decides whether this expansion starts at all.
 */
function fieldsOf(
  type: GraphQLObjectType | GraphQLInterfaceType,
  depth: number,
  seen: ReadonlySet<string>,
  path: string,
  builder: Builder,
  exclude: ReadonlySet<string> = new Set(),
): SelectionField[] {
  const { findings } = builder;
  const out: SelectionField[] = [];
  for (const field of Object.values(type.getFields())) {
    if (exclude.has(field.name)) continue;
    if (requiresArguments(field)) {
      const key = `${type.name}.${field.name}`;
      if (!findings.omitted.has(key)) {
        const args = field.args
          .filter((arg) => isNonNullType(arg.type) && arg.defaultValue === undefined)
          .map((arg) => `${arg.name}: ${arg.type.toString()}`)
          .join(", ");
        findings.omitted.set(key, `${key}(${args})`);
      }
      continue;
    }
    const named = getNamedType(field.type);
    const selected: SelectionField = {
      name: field.name,
      type: field.type,
      description: field.description,
      node: { kind: "leaf", type: named },
    };
    out.push(selected);
    select(named, depth + 1, seen, `${path}.${field.name}`, builder, (node) => {
      selected.node = node;
    });
  }
  builder.remaining -= out.length;
  return out;
}

function cut(
  type: GraphQLNamedType,
  reason: SelectionCut,
  path: string,
  findings: Findings,
): SelectionNode {
  findings.cuts.push({ path, type: type.name, reason });
  return { kind: "cut", type, reason };
}

/**
 * Count the fields a selection holds: what `MAX_SELECTION_FIELDS` bounds. Every
 * selected field at every level and inside every inline fragment counts once.
 */
export function countSelectedFields(node: SelectionNode): number {
  switch (node.kind) {
    case "leaf":
    case "cut":
      return 0;
    case "object":
      return countFields(node.fields);
    case "abstract":
      return (
        countFields(node.fields) +
        node.members.reduce((n, member) => n + countFields(member.fields ?? []), 0)
      );
  }
}

function countFields(fields: readonly SelectionField[]): number {
  return fields.reduce((n, field) => n + 1 + countSelectedFields(field.node), 0);
}

/* ------------------------------- the document ------------------------------ */

/** Render a node's selection set — ` { … }` — or nothing for a leaf. */
export function renderSelection(node: SelectionNode): string {
  switch (node.kind) {
    case "leaf":
      return "";
    case "cut":
      // `__typename` keeps the selection legal — an object selection may never
      // be empty — and says what was truncated.
      return " { __typename }";
    case "object":
      return node.fields.length === 0 ? " { __typename }" : ` { ${renderFields(node.fields)} }`;
    case "abstract": {
      // `__typename` first: it is what tells a caller which member came back.
      const parts = ["__typename"];
      if (node.fields.length > 0) parts.push(renderFields(node.fields));
      for (const member of node.members) {
        if (member.fields === undefined) {
          parts.push(`... on ${member.type.name} { __typename }`);
        } else if (member.fields.length > 0) {
          parts.push(`... on ${member.type.name} { ${renderFields(member.fields)} }`);
        }
      }
      return ` { ${parts.join(" ")} }`;
    }
  }
}

function renderFields(fields: readonly SelectionField[]): string {
  return fields.map((field) => `${field.name}${renderSelection(field.node)}`).join(" ");
}

/* -------------------------------- the schema ------------------------------- */

const BUILTIN_SCALARS: Record<string, JsonSchemaLike> = {
  Int: { type: "integer" },
  Float: { type: "number" },
  String: { type: "string" },
  Boolean: { type: "boolean" },
  ID: { type: "string", description: "GraphQL ID" },
};

export function scalarSchema(name: string): JsonSchemaLike {
  if (BUILTIN_SCALARS[name]) return { ...BUILTIN_SCALARS[name] };
  return { type: "string", description: `custom scalar ${name}` };
}

function ref(name: string): JsonSchemaLike {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Whether a node's whole subtree is the type's canonical selection — every
 * field the component lists, each itself canonical. Only then may the schema
 * point at the component, because only then does the component describe what
 * this position returns.
 */
function isCanonical(node: SelectionNode, memo: Map<SelectionNode, boolean>): boolean {
  const known = memo.get(node);
  if (known !== undefined) return known;
  let result: boolean;
  switch (node.kind) {
    case "leaf":
      result = true;
      break;
    case "cut":
      result = false;
      break;
    case "object":
      result = node.fields.every((field) => isCanonical(field.node, memo));
      break;
    case "abstract":
      result =
        node.fields.every((field) => isCanonical(field.node, memo)) &&
        node.members.every(
          (member) => member.fields?.every((field) => isCanonical(field.node, memo)) === true,
        );
      break;
  }
  memo.set(node, result);
  return result;
}

/**
 * Where the schemas a selection needs are registered: the lowering's
 * `components.schemas`, shared by every operation of one document.
 *
 * A position whose selection is not the type's canonical one cannot point at
 * the type's component, and it is not rendered inline either. It becomes a
 * *positional component*: a named entry describing exactly the fields selected
 * there, referenced with `$ref` like any vendor type. That is what keeps the
 * agent-facing schema bounded: `materializeSchema` follows `$ref`s to a depth
 * (one hop by default) and leaves a typed stub beyond it, and a `$ref` is the
 * only structure it counts. Inline structure is invisible to that bound —
 * rendering the selection inline for two levels put a GraphQL operation's
 * output two hops deeper than any REST operation's before the first `$ref` was
 * even reached, and a single GitHub operation materialized to 200KB. Through
 * components, a GraphQL operation's output is the same size as a REST one's
 * for the same type, and an exposure profile's `max_ref_depth` deepens both
 * alike.
 *
 * Positional components are deduplicated by content and named after the type
 * plus a content hash, so the same selection reached at two positions (or in
 * two operations) is one entry and the document's size stays proportional to
 * its distinct selections.
 */
export interface SchemaRegistry {
  /** The components synthesized so far, to merge into `components.schemas`. */
  positional: Record<string, JsonSchemaLike>;
  /** Positional component names by canonical body text, for deduplication. */
  byContent: Map<string, string>;
  /** Whether a name is already taken by a type of the SDL. */
  isTypeName: (name: string) => boolean;
  /** The component every cut position points at. */
  typenameOnlyName: string;
}

export function createSchemaRegistry(
  isTypeName: (name: string) => boolean,
  typenameOnlyName = TYPENAME_ONLY_SCHEMA,
): SchemaRegistry {
  return { positional: {}, byContent: new Map(), isTypeName, typenameOnlyName };
}

/** The response schema for a root field, wrapped exactly as its declared type is. */
export function responseSchemaFor(
  field: GraphQLField<unknown, unknown>,
  selection: Selection,
  registry: SchemaRegistry = createSchemaRegistry(() => false),
): JsonSchemaLike {
  const ctx: RenderContext = { canonical: new Map(), rendered: new Map(), registry };
  return wrapped(field.type, selection.root, ctx);
}

interface RenderContext {
  canonical: Map<SelectionNode, boolean>;
  /** Positional component names by the node (or member) they were rendered from. */
  rendered: Map<object, string>;
  registry: SchemaRegistry;
}

const canon = (value: unknown): string => JSON.stringify(value);

function wrapped(type: GraphQLOutputType, node: SelectionNode, ctx: RenderContext): JsonSchemaLike {
  if (isNonNullType(type)) return wrapped(type.ofType, node, ctx);
  if (isListType(type)) return { type: "array", items: wrapped(type.ofType, node, ctx) };
  return nodeSchema(node, ctx);
}

function nodeSchema(node: SelectionNode, ctx: RenderContext): JsonSchemaLike {
  switch (node.kind) {
    case "leaf":
      return isScalarType(node.type) ? scalarSchema(node.type.name) : ref(node.type.name);
    case "cut":
      return ref(ctx.registry.typenameOnlyName);
    case "object":
      if (isCanonical(node, ctx.canonical)) return ref(node.type.name);
      return ref(
        positional(node, node.type.name, () => objectBody(node.type, node.fields, ctx), ctx),
      );
    case "abstract":
      if (isCanonical(node, ctx.canonical)) return ref(node.type.name);
      return ref(
        positional(
          node,
          node.type.name,
          () => ({
            oneOf: node.members.map((member) => memberSchema(node, member, ctx)),
            description: `${node.type.name}: __typename names which member was returned.`,
          }),
          ctx,
        ),
      );
  }
}

function memberSchema(
  abstract: Extract<SelectionNode, { kind: "abstract" }>,
  member: SelectionMember,
  ctx: RenderContext,
): JsonSchemaLike {
  if (member.fields === undefined) return ref(ctx.registry.typenameOnlyName);
  const fields = [...abstract.fields, ...member.fields];
  if (fields.every((field) => isCanonical(field.node, ctx.canonical))) return ref(member.type.name);
  return ref(positional(member, member.type.name, () => objectBody(member.type, fields, ctx), ctx));
}

function objectBody(
  type: GraphQLObjectType | GraphQLInterfaceType,
  fields: readonly SelectionField[],
  ctx: RenderContext,
): JsonSchemaLike {
  const properties: Record<string, JsonSchemaLike> = {};
  const required: string[] = [];
  for (const field of fields) {
    const schema = wrapped(field.type, field.node, ctx);
    if (field.description) schema.description = field.description;
    properties[field.name] = schema;
    if (isNonNullType(field.type)) required.push(field.name);
  }
  return {
    type: "object",
    title: type.name,
    properties,
    ...(required.length ? { required } : {}),
    ...(type.description ? { description: type.description } : {}),
  };
}

/**
 * Register the component for one position and return its name. The body is
 * rendered at most once per node; an identical body already registered (from
 * another position or another operation) is reused under its existing name.
 */
function positional(
  key: object,
  typeName: string,
  render: () => JsonSchemaLike,
  ctx: RenderContext,
): string {
  const known = ctx.rendered.get(key);
  if (known !== undefined) return known;
  const body = render();
  const content = canon(body);
  let name = ctx.registry.byContent.get(content);
  if (name === undefined) {
    name = positionalName(typeName, content, ctx);
    ctx.registry.positional[name] = body;
    ctx.registry.byContent.set(content, name);
  }
  ctx.rendered.set(key, name);
  return name;
}

/**
 * `<Type>_at_<hash>`: the type the position returns, then eight hex digits of
 * the body's content hash. Deterministic for a given SDL, and stepping aside
 * from any SDL type or earlier (different) body that holds the name.
 */
function positionalName(typeName: string, content: string, ctx: RenderContext): string {
  const digest = createHash("sha256").update(content).digest("hex");
  for (let width = 8; ; width += 4) {
    const name = `${typeName}_at_${digest.slice(0, width)}`;
    if (!ctx.registry.isTypeName(name) && !(name in ctx.registry.positional)) return name;
  }
}

/** The component every cut position points at. */
export function typenameOnlySchema(): JsonSchemaLike {
  return {
    type: "object",
    description:
      "Only __typename is selected here: Anvil's compiled document stops at this position " +
      `(its selection is bounded to ${MAX_SELECTION_DEPTH} levels and ${MAX_SELECTION_FIELDS} ` +
      "fields in total, and never re-enters a type), so no other field of the object is " +
      "returned. Fetch it through a root field of its own.",
    properties: {
      __typename: { type: "string", description: "The concrete GraphQL type of this object." },
    },
    required: ["__typename"],
  };
}

/** One line per cut, for the diagnostic: `order.customer.orders (cycle back to Customer)`. */
export function describeCut(record: SelectionCutRecord): string {
  const why =
    record.reason === "cycle"
      ? `cycle back to ${record.type}`
      : record.reason === "depth"
        ? `depth budget of ${MAX_SELECTION_DEPTH} reached at ${record.type}`
        : `field budget of ${MAX_SELECTION_FIELDS} reached at ${record.type}`;
  return `${record.path} (${why})`;
}
