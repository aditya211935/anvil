/**
 * Agent-facing input names are a projection over exact wire names: snake_case
 * of the wire coordinate, unless an `agentName` says otherwise. Real vendor
 * contracts carry inputs that are distinct on the wire yet collapse under that
 * projection — Twilio's `EndTime`, `EndTime<`, `EndTime>` (the operator is a
 * separator snake_case erases), Zendesk's `role` and `role[]`, Microsoft
 * Graph's path `user-id` beside query `userId`, OData's `UserName` and
 * `userName` as two keys of one path. The validator rightly refuses one public
 * property that names two wire fields; this pass is the fix on the projection
 * side, so the operation compiles and every surface (CLI flag, MCP property,
 * SDK field, skill doc) still derives from the one `agentPropKey`.
 *
 * Only an input that actually collides is renamed — a no-collision operation
 * is byte-identical before and after — and an `agentName` a human already
 * chose (manifest or refinement) is never overwritten: if two chosen names
 * collide, the validator still blocks. The rules, in order, are deterministic
 * and keep the wire name untouched:
 *   1. comparison-operator suffix: `<` → `_lt`, `>` → `_gt`, `<=` → `_lte`,
 *      `>=` → `_gte`, `!=`/`<>` → `_ne` (`EndTime<` → `end_time_lt`);
 *   2. array-bracket suffix: `role[]` → `role_list`, the bare `role` keeps `role`;
 *   3. one name in several locations: the path parameter keeps the bare key
 *      (then query, body, header, cookie), the rest take a location suffix
 *      (`user_id_query`); a param that collides with the whole-body `body`
 *      envelope is treated the same way (`body_query`);
 *   4. what remains (case-only variants in one location) takes an ordinal in
 *      wire order: `user_name`, `user_name_2`.
 * Any candidate that would itself land on an occupied key takes the next free
 * ordinal, so the result is collision-free by construction.
 */
import {
  agentPropKey,
  type BodyField,
  type Diagnostic,
  isModeledIdempotencyCarrierInput,
  type Operation,
  type Param,
  type ParamLocation,
  resolveIdempotencyCarrier,
  snakeCase,
} from "@anvil/air";

type InputLocation = ParamLocation | "body";

interface PublicInput {
  node: Param | BodyField;
  location: InputLocation;
  /** `location:wireName`, the coordinate the validator and review notes speak in. */
  wire: string;
  /** Position in the operation's input order; the tie-breaker for ordinals. */
  order: number;
}

export interface InputRename {
  /** `location:wireName` of the renamed input. */
  wire: string;
  /** The agent-facing property key it now carries. */
  agentKey: string;
  /** Which rule chose the key. */
  rule: "comparison_operator" | "array_bracket" | "location" | "ordinal";
}

/** Two-character operators first, so `<=` is never read as `<` followed by `=`. */
const COMPARISON_SUFFIXES: ReadonlyArray<readonly [operator: string, suffix: string]> = [
  ["<=", "lte"],
  [">=", "gte"],
  ["!=", "ne"],
  ["<>", "ne"],
  ["<", "lt"],
  [">", "gt"],
];

/** Who keeps the bare key when one name appears in several locations. */
const LOCATION_RANK: Record<InputLocation, number> = {
  path: 0,
  query: 1,
  body: 2,
  header: 3,
  cookie: 4,
};

const RULE_REASON: Record<InputRename["rule"], string> = {
  comparison_operator: "comparison-operator suffix",
  array_bracket: "array-bracket suffix",
  location: "same name in another location",
  ordinal: "case-only variant in the same location",
};

/** A human-chosen agent name is a decision this pass may not revisit. */
const hasChosenName = (node: Param | BodyField): boolean => Boolean(node.agentName?.trim());

/**
 * Rules 1 and 2: a suffix the wire name carries that snake_case would erase.
 * Returns the candidate key and the rule, or nothing when the name has no
 * such suffix (or nothing but the suffix).
 */
function suffixCandidate(
  wireName: string,
): { key: string; rule: "comparison_operator" | "array_bracket" } | undefined {
  for (const [operator, suffix] of COMPARISON_SUFFIXES) {
    if (!wireName.endsWith(operator)) continue;
    const base = snakeCase(wireName.slice(0, -operator.length));
    return base ? { key: `${base}_${suffix}`, rule: "comparison_operator" } : undefined;
  }
  if (wireName.endsWith("[]")) {
    const base = snakeCase(wireName.slice(0, -2));
    return base ? { key: `${base}_list`, rule: "array_bracket" } : undefined;
  }
  return undefined;
}

function publicInputs(op: Operation): { inputs: PublicInput[]; reserved: Set<string> } {
  const carrier = resolveIdempotencyCarrier(op);
  const binding = carrier.ok ? carrier.binding : undefined;
  const inputs: PublicInput[] = [];
  let order = 0;
  for (const param of op.input.params) {
    if (isModeledIdempotencyCarrierInput(binding, param.in, param.name)) continue;
    inputs.push({ node: param, location: param.in, wire: `${param.in}:${param.name}`, order });
    order += 1;
  }
  const reserved = new Set<string>();
  if (op.input.body?.projection === "fields") {
    for (const field of op.input.body.fields) {
      if (isModeledIdempotencyCarrierInput(binding, "body", field.name)) continue;
      inputs.push({ node: field, location: "body", wire: `body:${field.name}`, order });
      order += 1;
    }
  } else if (op.input.body?.projection === "whole") {
    reserved.add("body");
  }
  return { inputs, reserved };
}

/**
 * Re-project the agent-facing names of an operation's colliding inputs, in
 * place, and return what moved. Inputs with a chosen `agentName` are fixed
 * points; everything else that shares a public key with another input (or with
 * the reserved whole-body `body` envelope) is given a distinct deterministic
 * key by the rules above. The wire name is never touched.
 */
export function disambiguateInputNames(op: Operation): InputRename[] {
  const { inputs, reserved } = publicInputs(op);
  const groups = new Map<string, PublicInput[]>();
  for (const input of inputs) {
    const key = agentPropKey(input.node);
    const group = groups.get(key);
    if (group) group.push(input);
    else groups.set(key, [input]);
  }

  const colliding = [...groups.entries()].filter(
    ([key, group]) => group.length > 1 || reserved.has(key),
  );
  if (colliding.length === 0) return [];

  // Every bare key stays reserved for the group that owns it — kept by that
  // group's keeper or left unused — so a suffixed candidate from one group can
  // never land on another group's bare name whatever the processing order.
  const occupied = new Set<string>([...reserved, ...groups.keys()]);

  const claim = (preferred: string): string => {
    let candidate = preferred;
    for (let ordinal = 2; occupied.has(candidate); ordinal += 1) {
      candidate = `${preferred}_${ordinal}`;
    }
    occupied.add(candidate);
    return candidate;
  };

  const renames: InputRename[] = [];
  const assign = (input: PublicInput, preferred: string, rule: InputRename["rule"]): void => {
    const agentKey = claim(preferred);
    input.node.agentName = agentKey;
    renames.push({ wire: input.wire, agentKey, rule });
  };

  for (const [key, group] of colliding) {
    const movable = group.filter((input) => !hasChosenName(input.node));
    // The bare key is taken (by a chosen name or the body envelope) unless it
    // is free for exactly the inputs that have no erasable suffix to move to.
    const bareTaken = reserved.has(key) || movable.length < group.length;

    // Rules 1 and 2 move the suffixed spellings away from the bare name.
    const remaining: PublicInput[] = [];
    for (const input of movable) {
      const suffixed = suffixCandidate(input.node.name);
      if (suffixed) assign(input, suffixed.key, suffixed.rule);
      else remaining.push(input);
    }

    // Rule 3: the highest-ranked location keeps the bare key; rule 4: a
    // same-location sibling takes an ordinal. Order within a rank is wire order.
    remaining.sort(
      (a, b) => LOCATION_RANK[a.location] - LOCATION_RANK[b.location] || a.order - b.order,
    );
    const keeper = bareTaken ? undefined : remaining[0];
    for (const input of remaining) {
      if (input === keeper) continue;
      if (keeper === undefined || input.location !== keeper.location) {
        assign(input, `${key}_${input.location}`, "location");
      } else {
        assign(input, key, "ordinal");
      }
    }
  }
  return renames;
}

/**
 * The compiler pass: disambiguate every operation's inputs and record what
 * moved as a review note on the operation plus an informational diagnostic,
 * so a reviewer can see which wire inputs now answer to which agent key and
 * why. Operations without collisions are left untouched.
 */
export function resolveInputNameCollisions(operations: Operation[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const op of operations) {
    const renames = disambiguateInputNames(op);
    if (renames.length === 0) continue;
    const detail = renames
      .map((r) => `'${r.wire}' → '${r.agentKey}' (${RULE_REASON[r.rule]})`)
      .join("; ");
    const note =
      "Agent-facing input names re-projected so distinct wire inputs stay distinct: " +
      `${detail}. Wire names are unchanged; each schema property records its 'x-anvil-wire-name'.`;
    if (!op.reviewNotes.includes(note)) op.reviewNotes.push(note);
    diagnostics.push({
      level: "info",
      code: "agent_input_name_disambiguated",
      message: `Operation '${op.id}' renamed colliding agent inputs: ${detail}.`,
      operationId: op.id,
    });
  }
  return diagnostics;
}
