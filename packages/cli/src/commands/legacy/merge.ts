import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  LEGACY_MERGE_DISAGREEMENT_CODE,
  type LegacyInventorySnapshot,
  LegacyMergeError,
  type LegacyMergeLineage,
  type LegacyMergeSource,
  mergeLegacyInventories,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { buildLegacyInventoryReport, type LegacyInventoryReport } from "./legacy.js";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const ERROR_REPORT_TYPE = "anvil.legacy-estate-inventory-merge-error";

interface MergeOptions {
  estate?: string;
  estateName?: string;
  out?: string;
  json?: boolean;
  check?: boolean;
}

interface CollectorTotals {
  collector: string;
  inputMembers: number;
  observations: number;
  diagnostics: number;
}

/**
 * The merged report is a complete inventory report: every downstream command
 * (graph, gaps, explain, diff, refine task) reads it unchanged. The `merge`
 * field adds provenance and cross-source agreement without altering the
 * inventory fields those commands verify.
 */
export interface LegacyMergeReport extends LegacyInventoryReport {
  merge: {
    sources: LegacyMergeSource[];
    lineages: LegacyMergeLineage[];
    summary: {
      sources: number;
      lineages: { consistent: number; divergent: number; singleOccurrence: number };
      crossSourceDisagreements: number;
    };
  };
}

class LegacyMergeCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacyMerge(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("merge")
      .summary("Merge several inventories of one estate into one verified snapshot.")
      .description(
        "Unions content-addressed artifacts, evidence, and observations from several offline exports (environments, applications, source plus deployed configuration) and reconciles them together. Nothing is chosen or dropped: records that disagree stay as conflicts, and each logical capability deployed at several coordinates carries explicit cross-source agreement or disagreement. The output is a complete inventory report that every downstream legacy command accepts.",
      )
      .argument("<inventory...>", "legacy inventory reports or inventory snapshots")
      .option("--estate <id>", "merged estate id (required when the inputs name different estates)")
      .option("--estate-name <name>", "human-readable merged estate name")
      .option("--out <file>", "write the complete report without overwriting different content")
      .option("--check", "exit non-zero when any logical capability disagrees across sources")
      .option("--json", "emit the complete machine-readable report")
      .action((inventories: string[], options: MergeOptions) => {
        ctx.code = runMerge(inventories, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runMerge(paths: readonly string[], options: MergeOptions, io: CliIO): number {
  try {
    if (options.estateName && !options.estate) {
      throw new LegacyMergeCommandError(
        "legacy/merge/invalid_option",
        "--estate-name requires --estate so the merged estate is named explicitly.",
      );
    }
    const inputs = paths.map(readMergeInput);
    const result = mergeLegacyInventories(
      inputs.map((input) => input.snapshot),
      options.estate
        ? {
            estate: {
              id: options.estate,
              ...(options.estateName ? { name: options.estateName } : {}),
            },
          }
        : {},
    );
    const report = buildReport(result, inputs);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.out) writeReport(options.out, serialized);
    if (options.json) io.out(serialized.trimEnd());
    else renderSummary(report, options.out, io);
    return options.check && report.merge.summary.crossSourceDisagreements > 0 ? 1 : 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { inventories: [...paths] },
    });
  }
}

interface MergeInput {
  snapshot: LegacyInventorySnapshot;
  collectors: CollectorTotals[];
}

function readMergeInput(path: string): MergeInput {
  const raw = readJson(path);
  if (isRecord(raw) && "inventory" in raw) {
    return {
      snapshot: verifyLegacyInventory(raw.inventory),
      collectors: Array.isArray(raw.collectors) ? raw.collectors.filter(isCollectorRun) : [],
    };
  }
  return { snapshot: verifyLegacyInventory(raw), collectors: [] };
}

function isCollectorRun(value: unknown): value is CollectorTotals {
  return (
    isRecord(value) &&
    typeof value.collector === "string" &&
    typeof value.inputMembers === "number" &&
    typeof value.observations === "number" &&
    typeof value.diagnostics === "number"
  );
}

function buildReport(
  result: ReturnType<typeof mergeLegacyInventories>,
  inputs: readonly MergeInput[],
): LegacyMergeReport {
  const base = buildLegacyInventoryReport({
    snapshot: result.snapshot,
    candidates: result.candidates,
    collectors: sumCollectors(inputs) as LegacyInventoryReport["collectors"],
  });
  const lineages = { consistent: 0, divergent: 0, singleOccurrence: 0 };
  for (const lineage of result.lineages) {
    if (lineage.agreement === "consistent") lineages.consistent += 1;
    else if (lineage.agreement === "divergent") lineages.divergent += 1;
    else lineages.singleOccurrence += 1;
  }
  return {
    ...base,
    merge: {
      sources: result.sources,
      lineages: result.lineages,
      summary: {
        sources: result.sources.length,
        lineages,
        crossSourceDisagreements: result.snapshot.diagnostics.filter(
          (diagnostic) => diagnostic.code === LEGACY_MERGE_DISAGREEMENT_CODE,
        ).length,
      },
    },
  };
}

function sumCollectors(inputs: readonly MergeInput[]): CollectorTotals[] {
  const seen = new Set<string>();
  const totals = new Map<string, CollectorTotals>();
  for (const input of inputs) {
    if (seen.has(input.snapshot.inventoryId)) continue;
    seen.add(input.snapshot.inventoryId);
    for (const run of input.collectors) {
      const current = totals.get(run.collector) ?? {
        collector: run.collector,
        inputMembers: 0,
        observations: 0,
        diagnostics: 0,
      };
      current.inputMembers += run.inputMembers;
      current.observations += run.observations;
      current.diagnostics += run.diagnostics;
      totals.set(run.collector, current);
    }
  }
  return [...totals.values()].sort((left, right) => left.collector.localeCompare(right.collector));
}

function renderSummary(report: LegacyMergeReport, output: string | undefined, io: CliIO): void {
  io.out(`Legacy merged inventory ${report.inventory.inventoryId}`);
  io.out(`  ${report.merge.summary.sources} source inventory(ies):`);
  for (const source of report.merge.sources) {
    const coordinates = source.coordinates
      .map((coordinate) => `${coordinate.environment}/${coordinate.application}`)
      .join(", ");
    io.out(`    ${source.inventoryId} (${coordinates || "no coordinates"})`);
  }
  io.out(
    `  ${report.summary.artifacts} artifact(s), ${report.summary.evidence} evidence record(s), ${report.summary.observations} invocation observation(s)`,
  );
  io.out(
    `  ${report.summary.candidates} candidate(s), ${report.summary.conflicts} explicit conflict(s)`,
  );
  const { lineages } = report.merge.summary;
  io.out(
    `  ${report.merge.lineages.length} logical lineage(s): ${lineages.consistent} consistent, ${lineages.divergent} divergent, ${lineages.singleOccurrence} single-occurrence`,
  );
  io.out(
    `  ${report.merge.summary.crossSourceDisagreements} cross-source disagreement warning(s); diagnostics: ${report.summary.diagnostics.error} error(s), ${report.summary.diagnostics.warning} warning(s), ${report.summary.diagnostics.info} info`,
  );
  if (output) io.out(`  report: ${output}`);
  if (lineages.divergent > 0) {
    io.out(
      "  Next: explain each divergent lineage's occurrences; the merge kept every value and chose none.",
    );
  }
}

function readJson(path: string): unknown {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyMergeCommandError(
      "legacy/merge_input_refused",
      `Refused '${path}': expected a regular, non-symbolic-link JSON file.`,
    );
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new LegacyMergeCommandError(
      "legacy/merge_input_too_large",
      `Refused '${path}': input exceeds ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    throw new LegacyMergeCommandError(
      "legacy/merge_input_invalid",
      `Refused '${path}': input is not valid JSON.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacyMergeCommandError(
      "legacy/merge_output_exists",
      `Refused to overwrite different legacy merged inventory report '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyMergeCommandError || error instanceof LegacyMergeError) {
    return error.code;
  }
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/merge_input_unreadable";
  }
  if (error instanceof z.ZodError) return "legacy/merge_input_invalid";
  const message = error instanceof Error ? error.message : String(error);
  if (/does not match|do not match|stale/i.test(message)) return "legacy/merge_input_stale";
  return "legacy/merge_failed";
}
