import { createHash } from "node:crypto";
import { hashCanonical } from "@anvil/air";
import {
  type CopybookDiagnostic,
  type CopybookFormat,
  type CopybookParseResult,
  parseCopybook,
} from "./copybook-parse.js";
import { type JsonSchema, projectCopybookSchema } from "./copybook-schema.js";

export const COPYBOOK_MAX_BYTES = 4 * 1024 * 1024;

export interface CopybookConversionInput {
  path: string;
  bytes: Uint8Array | string;
  /** `auto` detects a sequence area; force `fixed` or `free` when the detection is wrong. */
  format?: CopybookFormat | "auto";
}

export interface CopybookConversion {
  /** The JSON Schema document, absent when the copybook yields no data item. */
  schema?: JsonSchema;
  diagnostics: CopybookDiagnostic[];
  /** sha256 over the schema and diagnostics; identical input yields an identical hash. */
  contentHash: `sha256:${string}`;
  source: { path: string; bytes: number; digest: `sha256:${string}`; format?: CopybookFormat };
  itemCount: number;
}

/**
 * Convert one COBOL copybook into a draft-07 JSON Schema. Names stay verbatim,
 * every field records its declaration, byte offsets are computed
 * deterministically, and nothing is inferred about business meaning. `COPY`
 * statements are reported, never followed.
 */
export function convertCopybook(input: CopybookConversionInput): CopybookConversion {
  const raw = typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
  const digest: `sha256:${string}` = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const diagnostics: CopybookDiagnostic[] = [];
  const finish = (
    schema: JsonSchema | undefined,
    parsed: CopybookParseResult | undefined,
  ): CopybookConversion => ({
    ...(schema ? { schema } : {}),
    diagnostics,
    contentHash: `sha256:${hashCanonical({ schema: schema ?? null, diagnostics })}`,
    source: {
      path: input.path,
      bytes: raw.byteLength,
      digest,
      ...(parsed ? { format: parsed.format } : {}),
    },
    itemCount: parsed?.itemCount ?? 0,
  });

  if (raw.byteLength > COPYBOOK_MAX_BYTES) {
    diagnostics.push({
      level: "error",
      code: "legacy/copybook/oversized",
      message: `Refused '${input.path}': ${raw.byteLength} bytes exceeds the ${COPYBOOK_MAX_BYTES} byte limit.`,
    });
    return finish(undefined, undefined);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    diagnostics.push({
      level: "error",
      code: "legacy/copybook/non_utf8",
      message: `Refused '${input.path}': not UTF-8 text. Transcode EBCDIC members before conversion.`,
    });
    return finish(undefined, undefined);
  }
  if (text.includes("\0")) {
    diagnostics.push({
      level: "error",
      code: "legacy/copybook/binary_content",
      message: `Refused '${input.path}': the file contains NUL bytes.`,
    });
    return finish(undefined, undefined);
  }
  const parsed = parseCopybook(text, input.format ?? "auto");
  diagnostics.push(...parsed.diagnostics);
  if (parsed.roots.length === 0) {
    diagnostics.push({
      level: "error",
      code: "legacy/copybook/no_items",
      message: `'${input.path}' declares no 01- or 77-level data item.`,
    });
    return finish(undefined, parsed);
  }
  const schema = projectCopybookSchema(parsed, { path: input.path }, diagnostics);
  return finish(schema, parsed);
}
