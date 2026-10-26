import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  assessLegacyModernization,
  type LegacyCapabilityBinding,
  type LegacyCapabilityCandidate,
  type LegacyCollectionPlan,
  type LegacyInventorySnapshot,
  type LegacyProductInput,
  reconcileLegacyInventory,
  renderLegacyModernizationScorecard,
  verifyLegacyCollectionPlan,
  verifyLegacyInventory,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { z } from "zod";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { readBinding } from "./bridge.js";

const REPORT_TYPE = "anvil.legacy-modernization-scorecard";
const ERROR_REPORT_TYPE = "anvil.legacy-scorecard-error";
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_BINDING_FILES = 10_000;

interface ScorecardOptions {
  bindings?: string[];
  plan?: string;
  out?: string;
  format?: string;
  json?: boolean;
}

class LegacyScorecardCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function registerLegacyScorecard(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("scorecard")
      .summary("Score an estate's modernization state from its inventory and reviewed bindings.")
      .description(
        "Counts what the inventory contains, how much of it is understood, which candidates have a reviewed binding, which bindings have the one transport shape the queue bridge can conformance-test, and what blocks the rest. Every figure is a count over inventory or binding records; the scorecard proposes no approval, asserts no idempotency, and never reports a capability as ready. It exits 0 whenever its inputs verify: a scorecard is a reading, not a gate.",
      )
      .argument("<inventory>", "legacy inventory report or inventory snapshot")
      .option(
        "--bindings <paths...>",
        "reviewed capability bindings or decision reports: files, or directories of *.json",
      )
      .option("--plan <file>", "assess coverage against an addressed collection plan")
      .option("--format <format>", "output format for --out and the terminal: json | md", "json")
      .option("--out <file>", "write without overwriting different content")
      .option("--json", "emit the complete scorecard report as JSON")
      .action((inventory: string, options: ScorecardOptions) => {
        ctx.code = runScorecard(inventory, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runScorecard(inventoryPath: string, options: ScorecardOptions, io: CliIO): number {
  try {
    const format = parseFormat(options.format ?? "json");
    const input = readProductInput(inventoryPath);
    const plan = options.plan ? readPlan(options.plan) : undefined;
    const bindings = readBindings(options.bindings ?? []);
    const scorecard = assessLegacyModernization(input, {
      bindings,
      ...(plan ? { plan } : {}),
    });
    const report = { schemaVersion: 1, reportType: REPORT_TYPE, scorecard };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    const markdown = renderLegacyModernizationScorecard(scorecard);
    if (options.out) writeReport(options.out, format === "md" ? markdown : json);
    if (options.json) io.out(json.trimEnd());
    else if (format === "md") io.out(markdown.trimEnd());
    else {
      io.out(`Legacy modernization scorecard ${scorecard.scorecardId}`);
      io.out(
        `  estate ${scorecard.estate.id}: ${scorecard.capabilities.total} candidate(s), ${scorecard.capabilities.withConflicts.candidates} with conflict(s), ${scorecard.capabilities.businessSemantics.unknown} with unknown business semantics`,
      );
      io.out(
        `  coverage ${scorecard.coverage.outcome}; ${scorecard.coverage.unsatisfied.length} unsatisfied requirement(s)`,
      );
      io.out(
        `  review: ${scorecard.review.candidatesReviewed} candidate(s) reviewed, ${scorecard.review.candidatesUnreviewed} unreviewed; ${scorecard.review.byShape.executable_shape} executable-shape binding(s), ${scorecard.review.byShape.needs_driver} needing a driver`,
      );
      io.out(`  ${scorecard.blockers.length} blocker code(s)`);
      if (options.out) io.out(`  report: ${options.out}`);
    }
    return 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: {
        inventory: inventoryPath,
        ...(options.plan ? { plan: options.plan } : {}),
        ...(options.bindings?.length ? { bindings: options.bindings } : {}),
        ...(error instanceof LegacyScorecardCommandError ? error.details : {}),
      },
    });
  }
}

function parseFormat(value: string): "json" | "md" {
  const parsed = z.enum(["json", "md"]).safeParse(value);
  if (parsed.success) return parsed.data;
  throw new LegacyScorecardCommandError(
    "legacy/scorecard_invalid_option",
    `Invalid --format '${value}'. Use: json | md.`,
  );
}

/** Every binding file must verify; one unverifiable file refuses the whole scorecard. */
function readBindings(paths: readonly string[]): LegacyCapabilityBinding[] {
  const files = [...new Set(paths.flatMap(expandBindingPath))].sort();
  return files.map((file) => {
    try {
      return readBinding(file);
    } catch (error) {
      throw new LegacyScorecardCommandError(
        "legacy/scorecard_binding_unverifiable",
        `Refused binding '${file}': ${error instanceof Error ? error.message : String(error)}`,
        { binding: file },
      );
    }
  });
}

function expandBindingPath(path: string): string[] {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_binding_unverifiable",
      `Refused binding '${path}': symbolic links are not read.`,
      { binding: path },
    );
  }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_binding_unverifiable",
      `Refused binding '${path}': expected a regular file or a directory.`,
      { binding: path },
    );
  }
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(path, entry.name))
    .sort();
  if (entries.length > MAX_BINDING_FILES) {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_binding_limit",
      `Refused '${path}': more than ${MAX_BINDING_FILES} binding files.`,
      { binding: path },
    );
  }
  return entries;
}

function readPlan(path: string): LegacyCollectionPlan {
  return verifyLegacyCollectionPlan(unwrap(readJson(path), "plan"));
}

function readProductInput(path: string): LegacyProductInput {
  const raw = readJson(path);
  if (isRecord(raw) && "inventory" in raw) {
    const snapshot = verifyLegacyInventory(raw.inventory);
    const candidates = Array.isArray(raw.candidates)
      ? (raw.candidates as LegacyCapabilityCandidate[])
      : reconcileLegacyInventory(snapshot);
    const collectors = Array.isArray(raw.collectors) ? raw.collectors : [];
    return { snapshot, candidates, collectors: collectors as LegacyProductInput["collectors"] };
  }
  const snapshot = verifyLegacyInventory(raw) as LegacyInventorySnapshot;
  return { snapshot, candidates: reconcileLegacyInventory(snapshot), collectors: [] };
}

function readJson(path: string): unknown {
  const target = resolve(path);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_input_refused",
      `Refused '${path}': expected a regular, non-symbolic-link JSON file.`,
    );
  }
  if (stat.size > MAX_INPUT_BYTES) {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_input_too_large",
      `Refused '${path}': input exceeds ${MAX_INPUT_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_input_invalid",
      `Refused '${path}': input is not valid JSON.`,
    );
  }
}

function unwrap(value: unknown, key: string): unknown {
  return isRecord(value) && key in value ? value[key] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function writeReport(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacyScorecardCommandError(
      "legacy/scorecard_output_exists",
      `Refused to overwrite different legacy scorecard output '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function errorCode(error: unknown): string {
  if (error instanceof LegacyScorecardCommandError) return error.code;
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/scorecard_input_unreadable";
  }
  if (error instanceof z.ZodError) return "legacy/scorecard_input_invalid";
  const message = error instanceof Error ? error.message : String(error);
  if (/does not match|do not match|stale|reconcile/i.test(message)) {
    return "legacy/scorecard_input_stale";
  }
  return "legacy/scorecard_failed";
}
