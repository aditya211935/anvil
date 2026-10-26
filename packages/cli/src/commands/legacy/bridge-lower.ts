import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LegacyCapabilityBinding } from "@anvil/compiler/legacy";
import {
  LegacyLoweringError,
  type LegacyLoweringResult,
  lowerLegacyBindings,
} from "@anvil/legacy-bridge";
import type { Command } from "commander";
import { stringify as toYaml } from "yaml";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import {
  errorCode as bridgeErrorCode,
  LegacyBridgeCommandError,
  readBinding,
  writeReport,
} from "./bridge.js";

/**
 * `anvil legacy bridge lower` — turn reviewed bindings into the OpenAPI
 * document and Anvil manifest that `anvil compile` builds a bundle from.
 *
 * The lowering itself (`lowerLegacyBindings` in `@anvil/legacy-bridge`) owns
 * every semantic decision; this command reads files, refuses what it must,
 * and writes without overwriting different content. It never compiles,
 * approves, or serves anything.
 */

const REPORT_TYPE = "anvil.legacy-bridge-lower";
const ERROR_REPORT_TYPE = "anvil.legacy-bridge-lower-error";

interface BridgeLowerOptions {
  title: string;
  outSpec?: string;
  outManifest?: string;
  serviceId?: string;
  executableOnly?: boolean;
  json?: boolean;
}

export function registerLegacyBridgeLower(bridge: Command, ctx: CommandContext): void {
  annotate(
    bridge
      .command("lower")
      .summary("Lower reviewed bindings into an OpenAPI document and manifest for anvil compile.")
      .description(
        "Projects one or more reviewed LegacyCapabilityBinding JSON files (or directories of them) into an OpenAPI 3.0.3 document plus an Anvil manifest, so `anvil compile` gives each reviewed legacy operation the same CLI + MCP + skill triad every other operation gets. Each operation is POST /invoke/<operation name> — the route `anvil legacy bridge serve` answers for that binding — and carries the queue request/reply wire binding derived from the reviewed binding by content hash. Lowering never enables execution: a binding that has not passed conformance, or whose transport the queue bridge cannot execute, is held `state: blocked`; a conformance_passed binding is left to the compiler's own classification and still needs `anvil approve` after inspection; reviewed idempotency and retry semantics are carried only where they tighten. The runtime executes an approved operation only when an operator declares a protocol facade pointing at a served, conformance_passed binding. Refuses a binding that fails verification and two bindings that name one operation.",
      )
      .argument("<binding...>", "LegacyCapabilityBinding JSON files, or directories of them")
      .requiredOption("--title <title>", "the lowered document's info.title (the bundle's name)")
      .option(
        "--out-spec <file>",
        "write the OpenAPI document here (no overwrite of different content)",
      )
      .option(
        "--out-manifest <file>",
        "write the Anvil manifest YAML here (no overwrite of different content)",
      )
      .option(
        "--service-id <id>",
        "record a service name in the manifest; anvil compile derives one otherwise",
      )
      .option(
        "--executable-only",
        "omit bindings the queue bridge cannot execute instead of emitting them blocked",
      )
      .option("--json", "emit the complete lowering report, documents included")
      .action((bindings: string[], options: BridgeLowerOptions) => {
        ctx.code = runBridgeLower(bindings, options, ctx.io);
      }),
    { mutates: true },
  );
}

/** Every binding named by the arguments: a file is one, a directory is its `*.json` files, sorted. */
function collectBindingPaths(inputs: readonly string[]): string[] {
  const paths: string[] = [];
  for (const input of inputs) {
    const target = resolve(input);
    if (statSync(target).isDirectory()) {
      const files = readdirSync(target)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(target, name));
      if (files.length === 0) {
        throw new LegacyBridgeCommandError(
          "legacy/bridge_lower_no_bindings",
          `Refused '${input}': the directory holds no .json binding files.`,
        );
      }
      paths.push(...files);
    } else {
      paths.push(target);
    }
  }
  return paths;
}

function runBridgeLower(inputs: string[], options: BridgeLowerOptions, io: CliIO): number {
  try {
    const bindingPaths = collectBindingPaths(inputs);
    const bindings: LegacyCapabilityBinding[] = bindingPaths.map((path) => readBinding(path));
    const result = lowerLegacyBindings(bindings, {
      title: options.title,
      ...(options.serviceId ? { serviceId: options.serviceId } : {}),
      ...(options.executableOnly ? { executableOnly: true } : {}),
    });
    const spec = `${JSON.stringify(result.openapi, null, 2)}\n`;
    const manifest =
      "# Lowered by anvil legacy bridge lower. Review, compile, inspect, then approve — lowering\n" +
      "# never approves. Every state here is `blocked` or left to the compiler; nothing is loosened.\n" +
      toYaml(result.manifest);
    if (options.outSpec) writeReport(options.outSpec, spec);
    if (options.outManifest) writeReport(options.outManifest, manifest);
    const report = {
      schemaVersion: 1,
      reportType: REPORT_TYPE,
      title: options.title,
      contentHash: result.contentHash,
      lowered: result.lowered,
      refused: result.refused,
      outputs: {
        ...(options.outSpec ? { spec: options.outSpec } : {}),
        ...(options.outManifest ? { manifest: options.outManifest } : {}),
      },
      openapi: result.openapi,
      manifest: result.manifest,
    };
    if (options.json) io.out(JSON.stringify(report, null, 2));
    else printSummary(io, result, options);
    return 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { bindings: inputs, title: options.title },
    });
  }
}

function printSummary(io: CliIO, result: LegacyLoweringResult, options: BridgeLowerOptions): void {
  io.out(`Legacy bridge lowering ${result.contentHash}`);
  io.out(
    `  ${result.lowered.length} operation(s) lowered; ${result.refused.length} refused as executable`,
  );
  for (const op of result.lowered) {
    const posture =
      op.manifestState === "blocked"
        ? op.executable
          ? `blocked (${op.runtimeStatus})`
          : "blocked (not executable by the queue bridge)"
        : `compiler-classified (${op.runtimeStatus})`;
    io.out(`  ${op.operationName}: POST ${op.path} — ${posture}`);
  }
  for (const refusal of result.refused) {
    io.out(
      `  refused ${refusal.operationName}${refusal.emitted ? "" : " (omitted)"}: ${refusal.reason}`,
    );
  }
  io.out(
    "  execution: never enabled by lowering — compile, inspect, then `anvil approve`; the runtime " +
      "still needs a declared protocol facade pointing at `anvil legacy bridge serve`",
  );
  if (options.outSpec) io.out(`  spec: ${options.outSpec}`);
  if (options.outManifest) io.out(`  manifest: ${options.outManifest}`);
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyLoweringError) return `legacy/bridge_lower_${error.code}`;
  return bridgeErrorCode(error);
}
