import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  COPYBOOK_MAX_BYTES,
  type CopybookConversion,
  convertCopybook,
} from "@anvil/compiler/legacy";
import type { Command } from "commander";
import { emitRefusal } from "../../envelope.js";
import type { CliIO } from "../../io.js";
import type { CommandContext } from "../context.js";
import { annotate } from "../meta.js";

const REPORT_TYPE = "anvil.legacy-copybook-schema";
const ERROR_REPORT_TYPE = "anvil.legacy-copybook-schema-error";

interface CopybookOptions {
  out?: string;
  json?: boolean;
  format?: string;
}

interface CopybookReport {
  schemaVersion: 1;
  reportType: typeof REPORT_TYPE;
  source: CopybookConversion["source"];
  contentHash: CopybookConversion["contentHash"];
  schema: NonNullable<CopybookConversion["schema"]>;
  diagnostics: CopybookConversion["diagnostics"];
  summary: {
    title: string;
    fields: number;
    byteLength: number | undefined;
    items: number;
    diagnostics: { error: number; warning: number; info: number };
  };
}

class LegacySchemaCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function registerLegacySchema(parent: Command, ctx: CommandContext): void {
  const schema = parent
    .command("schema")
    .summary("Convert legacy record layouts into JSON Schema without inferring meaning.")
    .description(
      "Projects a declared record layout into a draft-07 JSON Schema. Field names stay verbatim, every field records its source declaration and byte offset, and nothing about business meaning is inferred.",
    );

  annotate(
    schema
      .command("copybook")
      .summary("Convert one COBOL copybook into a JSON Schema with byte offsets.")
      .description(
        "Reads one regular copybook file as inert text (fixed columns 8-72, or free format when no sequence area is detected). Level numbers, PICTURE, USAGE, OCCURS, REDEFINES, 88-level conditions, and FILLER become a draft-07 JSON Schema whose fields keep their COBOL names and carry their declaration under x-anvil-cobol. COPY statements are reported, never followed.",
      )
      .argument("<file>", "COBOL copybook (.cpy/.cob/.cbl) as UTF-8 text")
      .option("--format <format>", "source format: auto | fixed | free", "auto")
      .option(
        "--out <file>",
        "write the JSON Schema document without overwriting different content",
      )
      .option("--json", "emit the complete machine-readable report")
      .action((file: string, options: CopybookOptions) => {
        ctx.code = runCopybook(file, options, ctx.io);
      }),
    { mutates: true },
  );
}

function runCopybook(file: string, options: CopybookOptions, io: CliIO): number {
  try {
    const format = options.format ?? "auto";
    if (format !== "auto" && format !== "fixed" && format !== "free") {
      throw new LegacySchemaCommandError(
        "legacy/invalid_option",
        `Invalid --format '${format}'. Use: auto | fixed | free.`,
      );
    }
    const bytes = readCopybook(file);
    const conversion = convertCopybook({ path: file, bytes, format });
    if (!conversion.schema) {
      const first = conversion.diagnostics.find((diagnostic) => diagnostic.level === "error");
      throw new LegacySchemaCommandError(
        first?.code === "legacy/copybook/no_items"
          ? "legacy/schema_no_items"
          : first?.code === "legacy/copybook/oversized"
            ? "legacy/schema_source_too_large"
            : "legacy/schema_source_refused",
        first?.message ?? `Refused '${file}': no schema could be produced.`,
      );
    }
    const report = buildReport(conversion, conversion.schema);
    if (options.out) writeDocument(options.out, `${JSON.stringify(report.schema, null, 2)}\n`);
    if (options.json) io.out(JSON.stringify(report, null, 2));
    else renderSummary(report, options.out, io);
    return report.summary.diagnostics.error > 0 ? 1 : 0;
  } catch (error) {
    return emitRefusal(io, options.json, {
      reportType: ERROR_REPORT_TYPE,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      details: { file },
    });
  }
}

function readCopybook(file: string): Uint8Array {
  const target = resolve(file);
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LegacySchemaCommandError(
      "legacy/schema_source_refused",
      `Refused '${file}': expected a regular, non-symbolic-link file.`,
    );
  }
  if (stat.size > COPYBOOK_MAX_BYTES) {
    throw new LegacySchemaCommandError(
      "legacy/schema_source_too_large",
      `Refused '${file}': ${stat.size} bytes exceeds the ${COPYBOOK_MAX_BYTES} byte limit.`,
    );
  }
  return new Uint8Array(readFileSync(target));
}

function buildReport(
  conversion: CopybookConversion,
  schema: NonNullable<CopybookConversion["schema"]>,
): CopybookReport {
  const diagnostics = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of conversion.diagnostics) diagnostics[diagnostic.level] += 1;
  const extension = schema["x-anvil-cobol"] as Record<string, unknown> | undefined;
  const properties = schema.properties as Record<string, unknown> | undefined;
  return {
    schemaVersion: 1,
    reportType: REPORT_TYPE,
    source: conversion.source,
    contentHash: conversion.contentHash,
    schema,
    diagnostics: conversion.diagnostics,
    summary: {
      title: typeof schema.title === "string" ? schema.title : "",
      fields: properties ? Object.keys(properties).length : 0,
      byteLength: typeof extension?.byteLength === "number" ? extension.byteLength : undefined,
      items: conversion.itemCount,
      diagnostics,
    },
  };
}

function writeDocument(path: string, content: string): void {
  const target = resolve(path);
  if (existsSync(target)) {
    if (readFileSync(target, "utf8") === content) return;
    throw new LegacySchemaCommandError(
      "legacy/output_exists",
      `Refused to overwrite different JSON Schema document '${path}'.`,
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
}

function renderSummary(report: CopybookReport, output: string | undefined, io: CliIO): void {
  io.out(`Copybook schema ${report.contentHash}`);
  io.out(
    `  ${report.summary.title}: ${report.summary.fields} top-level field(s), ${report.summary.items} data item(s)` +
      (report.summary.byteLength === undefined ? "" : `, ${report.summary.byteLength} byte(s)`),
  );
  io.out(`  format: ${report.source.format ?? "unknown"}; names kept verbatim; COPY not followed`);
  io.out(
    `  diagnostics: ${report.summary.diagnostics.error} error(s), ${report.summary.diagnostics.warning} warning(s), ${report.summary.diagnostics.info} info`,
  );
  if (output) io.out(`  schema: ${output}`);
}

function errorCode(error: unknown): string {
  if (error instanceof LegacySchemaCommandError) return error.code;
  const nodeCode =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(nodeCode ?? "")) {
    return "legacy/schema_source_unreadable";
  }
  if (nodeCode === "EEXIST") return "legacy/output_exists";
  return "legacy/schema_failed";
}
