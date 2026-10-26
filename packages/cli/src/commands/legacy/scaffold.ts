import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { LegacyScaffoldLane, scaffoldLegacySource } from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";
import { readLegacySourceSet } from "./source-files.js";

const REPORT_TYPE = "anvil.legacy-scaffold";
const ERROR_REPORT_TYPE = "anvil.legacy-scaffold-error";

interface ScaffoldOptions {
  title?: string;
  version?: string;
  lane?: string;
  out?: string;
  json?: boolean;
}

export function registerLegacyScaffold(parent: Command, ctx: CommandContext): void {
  annotate(
    parent
      .command("scaffold")
      .summary("Draft an OpenAPI contract from legacy source that has none.")
      .description(
        "Reads Java (JAX-RS, Spring MVC, web.xml) and .NET (ASP.NET attribute routing, ASMX) source as inert text and emits a deterministic OpenAPI 3 draft whose every operation records the source coordinates it was read from. The draft compiles through `anvil compile` like any specification; nothing in it carries business semantics the source did not declare, so mutations land review_required.",
      )
      .argument("<source>", "source directory or one source file")
      .option("--title <title>", "info.title for the draft (default: source directory name)")
      .option("--version <version>", "info.version for the draft")
      .option("--lane <lane>", `scaffold lane (${LegacyScaffoldLane.options.join(" | ")})`, "auto")
      .option(
        "--out <file>",
        "write the OpenAPI draft (JSON) without overwriting different content",
      )
      .option("--json", "emit the complete machine-readable report")
      .action((source: string, options: ScaffoldOptions) => {
        ctx.code = runScaffold(source, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runScaffold(source: string, options: ScaffoldOptions, io: CliIO): number {
  try {
    const lane = LegacyScaffoldLane.safeParse(options.lane ?? "auto");
    if (!lane.success) {
      throw new Error(
        `Invalid --lane '${options.lane}'. Use: ${LegacyScaffoldLane.options.join(" | ")}.`,
      );
    }
    const sourceSet = readLegacySourceSet(source);
    const result = scaffoldLegacySource({
      title: options.title ?? sourceSet.label,
      ...(options.version ? { version: options.version } : {}),
      lane: lane.data,
      members: sourceSet.members.map(({ path, bytes }) => ({ path, bytes })),
    });
    const serializedDraft = `${JSON.stringify(result.draft.document, null, 2)}\n`;
    if (options.out) writeOutput(options.out, serializedDraft);

    const errors = result.draft.diagnostics.filter((d) => d.level === "error").length;
    const warnings = result.draft.diagnostics.filter((d) => d.level === "warning").length;
    const operations = Object.values(
      result.draft.document.paths as Record<string, Record<string, unknown>>,
    ).reduce((total, methods) => total + Object.keys(methods).length, 0);
    const report = {
      schemaVersion: 1,
      reportType: REPORT_TYPE,
      contentHash: result.draft.contentHash,
      lanes: result.lanes.map(({ lane: name, result: lane }) => ({
        lane: name,
        inputMembers: lane.inputMembers,
        endpoints: lane.endpoints.length,
        diagnostics: lane.diagnostics.length,
      })),
      summary: { operations, unmapped: result.draft.unmapped.length, errors, warnings },
      diagnostics: result.draft.diagnostics,
      ...(options.out ? { out: options.out } : {}),
      ...(options.json && !options.out ? { document: result.draft.document } : {}),
    };
    if (options.json) {
      io.out(JSON.stringify(report, null, 2));
    } else {
      io.out(`Legacy scaffold ${result.draft.contentHash}`);
      io.out(
        `  ${operations} operation(s) drafted, ${result.draft.unmapped.length} path(s) left unmapped (no declared method)`,
      );
      io.out(`  diagnostics: ${errors} error(s), ${warnings} warning(s)`);
      for (const lane of report.lanes) {
        io.out(
          `  lane ${lane.lane}: ${lane.inputMembers} member(s), ${lane.endpoints} endpoint(s)`,
        );
      }
      if (options.out) io.out(`  draft: ${options.out}`);
      if (operations > 0) {
        io.out(
          "  Next: `anvil compile <draft> --out <dir>` then `anvil inspect <dir>`; approve nothing you have not reviewed.",
        );
      }
    }
    return errors > 0 ? 1 : 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { source },
    });
  }
}

function writeOutput(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new Error(`Refused to overwrite different scaffold draft '${path}'.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/source_unreadable";
  }
  if (/Invalid --lane/.test(message)) return "legacy/invalid_option";
  if (/symbolic link/i.test(message)) return "legacy/source_symlink_refused";
  if (/limit|exceeds/i.test(message)) return "legacy/source_limit_exceeded";
  if (/overwrite/i.test(message) || nodeCode === "EEXIST") return "legacy/output_exists";
  return "legacy/scaffold_failed";
}
