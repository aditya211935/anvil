/**
 * Lower reviewed `LegacyCapabilityBinding` records into the two inputs
 * `anvil compile` already understands — an OpenAPI 3.0.3 document and an Anvil
 * manifest — so a reviewed legacy operation gets the same CLI + MCP + skill
 * triad every other Anvil operation gets, from the same compiler, with no
 * second pipeline to keep honest.
 *
 * Three surfaces have to agree, and this module is where the agreement is
 * made rather than hoped for:
 *
 * - **What the bundle says** — one OpenAPI operation per binding. Its wire
 *   facts are `buildQueueWireBinding(binding)` verbatim (`x-anvil-wire-binding`),
 *   so `sourceRef.binding.legacyBindingContentHash` is the true content hash
 *   of the reviewed binding, never a value authored here.
 * - **What the facade serves** — `POST` on `legacyBridgeInvokePath(name)`,
 *   the same function `facade.ts` routes on. The path the bundle declares is
 *   the path the facade answers, by construction.
 * - **What the runtime does** — nothing, until an operator declares a protocol
 *   facade. `@anvil/air`'s `wireExecutability` refuses `queue_request_reply`
 *   with a "coordinates" refusal; `protocolFacadeApplies` is what lets a
 *   declared `--protocol-facade` / `ANVIL_PROTOCOL_FACADE` carry it.
 *
 * Lowering never enables execution. A binding that has not passed conformance
 * is held `blocked` by the manifest; one that has is left to the compiler's
 * own classification (`review_required` for a mutation) and still needs
 * `anvil approve` after inspection. Nothing here writes `approved`, and the
 * reviewed idempotency/retry semantics are carried only in the tightening
 * direction (see `manifestEntryFor`).
 */
import { hashCanonical } from "@anvil/air";
import {
  type LegacyCapabilityBinding,
  verifyLegacyCapabilityBinding,
} from "@anvil/compiler/legacy";
import { legacyBridgeInvokePath } from "./facade.js";
import { buildQueueWireBinding, LegacyBridgeShapeError } from "./wire-binding.js";

export type LegacyLoweringErrorCode =
  | "no_bindings"
  | "invalid_binding"
  | "duplicate_operation_name";

/** Refused before any document is produced — a lowering is all or nothing. */
export class LegacyLoweringError extends Error {
  constructor(
    readonly code: LegacyLoweringErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LegacyLoweringError";
  }
}

export interface LowerLegacyBindingsOptions {
  /** `info.title` of the lowered document — the bundle's display name. */
  title: string;
  /** Recorded as the manifest's `service.name`; `anvil compile` derives one otherwise. */
  serviceId?: string;
  /**
   * Omit bindings no facade can execute from the document and manifest. They
   * still appear in `refused`, so the refusal is reported either way; by
   * default they are emitted as visible, blocked operations so the bundle
   * shows the whole reviewed estate.
   */
  executableOnly?: boolean;
}

export interface LoweredLegacyOperation {
  operationId: string;
  operationName: string;
  bindingId: string;
  contentHash: string;
  runtimeStatus: LegacyCapabilityBinding["runtime"]["status"];
  /** Whether the operation carries a wire binding a served facade executes. */
  executable: boolean;
  path: string;
  method: "post";
  /** The state the manifest pins, or undefined when the compiler decides. */
  manifestState?: "blocked";
}

export interface RefusedLegacyBinding {
  operationName: string;
  bindingId: string;
  /** The `LegacyBridgeShapeError` message, or this module's own payload refusal. */
  reason: string;
  /** False under `executableOnly`: the binding is reported but not in the document. */
  emitted: boolean;
}

export interface LegacyLoweringResult {
  openapi: Record<string, unknown>;
  manifest: Record<string, unknown>;
  lowered: LoweredLegacyOperation[];
  refused: RefusedLegacyBinding[];
  /** Content hash of `{ openapi, manifest }` — equal inputs lower to equal outputs. */
  contentHash: string;
}

const OPERATION_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * The binding's reviewed operation name is the operationId whenever it can be
 * (`LegacyBusinessOperation.name` is `[a-z0-9_.]`, so today it always is).
 * The fallback is deterministic and the original is always recorded in
 * `x-anvil-legacy.operationName`, so nothing is lost if the name grammar
 * ever widens.
 */
function operationIdFor(name: string): string {
  if (OPERATION_ID.test(name)) return name;
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  return /^[A-Za-z_]/.test(safe) ? safe : `_${safe}`;
}

type Executability =
  | { executable: true; wireBinding: ReturnType<typeof buildQueueWireBinding> }
  | { executable: false; reason: string };

/**
 * Whether a served facade would execute this binding. The shape gate is
 * `buildQueueWireBinding` itself — reused, not restated, so this can never
 * admit a transport `serve` would refuse. One further refusal is this
 * module's own: the facade relays the HTTP body verbatim and Anvil's runtime
 * puts JSON on the wire, so a binding whose reviewed payload encoding is not
 * JSON would be published mis-encoded. Tightening only — it never admits
 * more than the facade does.
 */
function executabilityOf(binding: LegacyCapabilityBinding): Executability {
  let wireBinding: ReturnType<typeof buildQueueWireBinding>;
  try {
    wireBinding = buildQueueWireBinding(binding);
  } catch (error) {
    if (error instanceof LegacyBridgeShapeError) {
      return { executable: false, reason: error.message };
    }
    throw error;
  }
  if (binding.transport.kind === "message" && binding.transport.payloadEncoding !== "json") {
    return {
      executable: false,
      reason:
        `binding '${binding.bindingId}' declares a '${binding.transport.payloadEncoding}' payload ` +
        "encoding — the bridge relays the HTTP body verbatim and Anvil's runtime encodes JSON, so " +
        "the exchange would carry a mis-encoded payload.",
    };
  }
  return { executable: true, wireBinding };
}

function openApiOperationFor(
  binding: LegacyCapabilityBinding,
  operationId: string,
  executability: Executability,
): Record<string, unknown> {
  const { operation, semantics } = binding;
  const namespace = operation.name.split(".").slice(0, -1).join(".");
  const responses: Record<string, unknown> = {
    "200": {
      description: "The correlated reply, in the shape of the binding's reviewed output schema.",
      content: { "application/json": { schema: operation.outputSchema } },
    },
  };
  if (executability.executable) {
    // The two statuses the facade itself answers with (facade.ts). Facts about
    // the bridge, not claims about the legacy system; the runtime already maps
    // both to its structured error codes.
    responses["502"] = {
      description:
        "The bridge could not complete the exchange: the broker refused or failed it " +
        "(upstream_unavailable; the bridge never retries).",
    };
    responses["504"] = {
      description:
        `No reply within the reviewed timeout of ${semantics.timeoutMs}ms ` +
        "(upstream_timeout; the bridge never retries).",
    };
  }
  if (operation.errors.length > 0) {
    // A reviewed legacy error names a code, a meaning, and a recovery — never
    // an HTTP status, because the legacy system has none. Carried verbatim on
    // the `default` response rather than invented into a status map.
    responses.default = {
      description:
        "Error codes the review assigned to this operation; the binding assigns them no HTTP status.",
      "x-anvil-legacy-errors": operation.errors,
    };
  }
  return {
    operationId,
    summary: operation.summary,
    description: operation.description,
    ...(namespace ? { tags: [namespace] } : {}),
    requestBody: {
      required: true,
      content: { "application/json": { schema: operation.inputSchema } },
    },
    responses,
    ...(executability.executable ? { "x-anvil-wire-binding": executability.wireBinding } : {}),
    ...(operation.effect === "read" ? { "x-anvil-effect": "read" } : {}),
    "x-anvil-legacy": {
      bindingId: binding.bindingId,
      contentHash: binding.contentHash,
      runtimeStatus: binding.runtime.status,
      ...(binding.runtime.status === "conformance_passed"
        ? { conformanceReportHash: binding.runtime.conformanceReportHash }
        : {}),
      inventoryId: binding.inventoryId,
      candidateId: binding.candidateId,
      receiptId: binding.receiptId,
      operationName: operation.name,
      effect: operation.effect,
      exposure: operation.exposure,
      transportKind: binding.transport.kind,
      executable: executability.executable,
      ...(executability.executable ? {} : { refusal: executability.reason }),
    },
  };
}

/**
 * The manifest entry for one lowered operation. Every field here either holds
 * the operation back or records why — nothing loosens:
 *
 * - `state: blocked` for a binding no facade executes or none has proven
 *   (`not_implemented`). A `conformance_passed` binding gets no state: the
 *   compiler classifies it (`review_required` for a mutation) and approval
 *   stays with `anvil approve`.
 * - `retries.enabled: false` unless the review said `safe_transient`; a
 *   `never` or `operator_only` review must not become an automatic retry.
 * - `idempotency.strategy: none` when the review said `none`. A reviewed
 *   `natural` or `client_key` is NOT asserted here — that would loosen the
 *   compiler's own `none` default on the strength of a field this module
 *   cannot verify; it is recorded in the review reason for a human instead.
 */
function manifestEntryFor(
  binding: LegacyCapabilityBinding,
  executability: Executability,
): { entry: Record<string, unknown>; state?: "blocked" } {
  const { semantics, runtime } = binding;
  const held = !executability.executable
    ? `cannot be executed by the queue bridge: ${executability.reason}`
    : runtime.status !== "conformance_passed"
      ? `has runtime status '${runtime.status}' and has not passed bridge conformance`
      : undefined;
  const reviewed =
    `reviewed semantics: idempotency ${semantics.idempotency.mode}` +
    `${semantics.idempotency.carrier ? ` (carrier ${semantics.idempotency.carrier})` : ""}, ` +
    `retry ${semantics.retry.mode}, completion ${semantics.completion}`;
  const reason = held
    ? `Legacy binding ${binding.bindingId} ${held}; held blocked by anvil legacy bridge lower. ${reviewed}.`
    : `Legacy binding ${binding.bindingId} passed bridge conformance (report ` +
      `${runtime.status === "conformance_passed" ? runtime.conformanceReportHash : "unknown"}). ` +
      "Execution still requires a declared protocol facade pointing at anvil legacy bridge serve " +
      `for this binding; approval remains anvil approve after inspection. ${reviewed}.`;
  const entry: Record<string, unknown> = {
    ...(held ? { state: "blocked" } : {}),
    review_reason: reason,
    ...(semantics.retry.mode !== "safe_transient" ? { retries: { enabled: false } } : {}),
    ...(semantics.idempotency.mode === "none" ? { idempotency: { strategy: "none" } } : {}),
  };
  return held ? { entry, state: "blocked" } : { entry };
}

/**
 * Lower reviewed bindings. Deterministic: bindings are sorted by operation
 * name, and every id and hash in the output is content-derived. Refuses
 * (throws `LegacyLoweringError`) on an empty set, a binding that fails
 * `verifyLegacyCapabilityBinding`, or two bindings sharing an operation name
 * — a bundle with two different reviews of one name is not a bundle anyone
 * should compile.
 */
export function lowerLegacyBindings(
  inputs: readonly unknown[],
  options: LowerLegacyBindingsOptions,
): LegacyLoweringResult {
  if (inputs.length === 0) {
    throw new LegacyLoweringError("no_bindings", "No legacy capability bindings to lower.");
  }
  const bindings = inputs.map((input, index) => {
    try {
      return verifyLegacyCapabilityBinding(input);
    } catch (error) {
      throw new LegacyLoweringError(
        "invalid_binding",
        `Binding ${index + 1} of ${inputs.length} is not a verified LegacyCapabilityBinding: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  bindings.sort((a, b) => (a.operation.name < b.operation.name ? -1 : 1));
  for (let i = 1; i < bindings.length; i += 1) {
    const previous = bindings[i - 1] as LegacyCapabilityBinding;
    const current = bindings[i] as LegacyCapabilityBinding;
    if (previous.operation.name === current.operation.name) {
      throw new LegacyLoweringError(
        "duplicate_operation_name",
        `Bindings '${previous.bindingId}' and '${current.bindingId}' both name operation ` +
          `'${current.operation.name}'; one bundle cannot carry two reviews of one operation.`,
      );
    }
  }

  const paths: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const lowered: LoweredLegacyOperation[] = [];
  const refused: RefusedLegacyBinding[] = [];
  const lineage: Array<Record<string, unknown>> = [];

  for (const binding of bindings) {
    const executability = executabilityOf(binding);
    if (!executability.executable) {
      refused.push({
        operationName: binding.operation.name,
        bindingId: binding.bindingId,
        reason: executability.reason,
        emitted: options.executableOnly !== true,
      });
      if (options.executableOnly) continue;
    }
    const operationId = operationIdFor(binding.operation.name);
    const path = legacyBridgeInvokePath(binding.operation.name);
    paths[path] = { post: openApiOperationFor(binding, operationId, executability) };
    const manifest = manifestEntryFor(binding, executability);
    operations[operationId] = manifest.entry;
    lineage.push({ bindingId: binding.bindingId, contentHash: binding.contentHash });
    lowered.push({
      operationId,
      operationName: binding.operation.name,
      bindingId: binding.bindingId,
      contentHash: binding.contentHash,
      runtimeStatus: binding.runtime.status,
      executable: executability.executable,
      path,
      method: "post",
      ...(manifest.state ? { manifestState: manifest.state } : {}),
    });
  }

  const openapi: Record<string, unknown> = {
    openapi: "3.0.3",
    info: {
      title: options.title,
      version: "1.0.0",
      description:
        `Lowered by anvil legacy bridge lower from ${lineage.length} reviewed legacy capability ` +
        "binding(s). Every operation is a queue request/reply exchange behind a deployment-local " +
        "bridge (@anvil/legacy-bridge): Anvil's runtime never speaks it directly and executes an " +
        "approved operation only when an operator declares a protocol facade (--protocol-facade / " +
        "ANVIL_PROTOCOL_FACADE) and points ANVIL_BASE_URL at `anvil legacy bridge serve` for that " +
        "binding. Lowering never approves anything.",
    },
    // No server: the address is a deployment fact an operator declares, never
    // one a reviewed binding knows.
    servers: [],
    paths,
    "x-anvil-legacy": { schemaVersion: 1, bindings: lineage },
  };
  const manifest: Record<string, unknown> = {
    service: {
      ...(options.serviceId ? { name: options.serviceId } : {}),
      display_name: options.title,
    },
    operations,
  };
  return {
    openapi,
    manifest,
    lowered,
    refused,
    contentHash: `sha256:${hashCanonical({ openapi, manifest })}`,
  };
}
