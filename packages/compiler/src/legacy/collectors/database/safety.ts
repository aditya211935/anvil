import { createHash } from "node:crypto";
import type {
  DatabaseArtifactEvidence,
  DatabaseArtifactInput,
  DatabaseDiagnostic,
} from "./model.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/;

export interface AcceptedDatabaseArtifact {
  path: string;
  raw: Uint8Array;
  text: string;
  evidence: DatabaseArtifactEvidence;
}

/**
 * Admit DDL exports as inert text. The scanner never evaluates SQL, so the only
 * admission questions are size, encoding, path safety, and duplicate paths.
 */
export function acceptDatabaseArtifacts(inputs: readonly DatabaseArtifactInput[]): {
  artifacts: AcceptedDatabaseArtifact[];
  diagnostics: DatabaseDiagnostic[];
} {
  if (inputs.length > MAX_FILES) {
    return {
      artifacts: [],
      diagnostics: [
        {
          level: "error",
          code: "database/too_many_artifacts",
          message: `Refused ${inputs.length} artifacts; the collector limit is ${MAX_FILES}.`,
        },
      ],
    };
  }
  const duplicatePaths = duplicatePathSet(inputs);
  const diagnostics: DatabaseDiagnostic[] = [];
  const artifacts: AcceptedDatabaseArtifact[] = [];
  let totalBytes = 0;
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    if (input.path.length > 4096 || !SAFE_PATH.test(input.path)) {
      diagnostics.push(refusal("database/unsafe_artifact_path", input.path));
      continue;
    }
    if (duplicatePaths.has(input.path)) {
      diagnostics.push(refusal("database/duplicate_artifact_path", input.path));
      continue;
    }
    const raw =
      typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
    totalBytes += raw.byteLength;
    if (raw.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push({
        level: "error",
        code: "database/oversized_artifact",
        message: `Refused DDL export '${input.path}'; members above ${MAX_FILE_BYTES} bytes or exports above ${MAX_TOTAL_BYTES} total bytes are not scanned.`,
        coordinate: { origin: input.path },
      });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      diagnostics.push(refusal("database/non_utf8_artifact", input.path));
      continue;
    }
    artifacts.push({
      path: input.path,
      raw,
      text,
      evidence: {
        path: input.path,
        digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
        bytes: raw.byteLength,
        mediaType: "application/sql",
        role: "sql_script",
      },
    });
  }
  return { artifacts, diagnostics: deduplicateDiagnostics(diagnostics) };
}

/**
 * Replace `--` line comments, `/* ... *\/` block comments, and single-quoted
 * string literals with spaces of identical length so later scans never read
 * commented-out DDL, dynamic SQL inside literals, or message text, while every
 * reported span still indexes the original text.
 */
export function scrubSql(text: string): string {
  const out: string[] = [];
  let index = 0;
  const length = text.length;
  while (index < length) {
    const character = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (character === "-" && next === "-") {
      while (index < length && text[index] !== "\n") {
        out.push(" ");
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      out.push(" ", " ");
      index += 2;
      while (index < length && !(text[index] === "*" && text[index + 1] === "/")) {
        out.push(text[index] === "\n" ? "\n" : " ");
        index += 1;
      }
      if (index < length) {
        out.push(" ", " ");
        index += 2;
      }
      continue;
    }
    if (character === "'" || (character === "N" && next === "'")) {
      if (character === "N") {
        out.push(" ");
        index += 1;
      }
      out.push("'");
      index += 1;
      while (index < length) {
        if (text[index] === "'" && text[index + 1] === "'") {
          out.push(" ", " ");
          index += 2;
          continue;
        }
        if (text[index] === "'") break;
        out.push(text[index] === "\n" ? "\n" : " ");
        index += 1;
      }
      if (index < length) {
        out.push("'");
        index += 1;
      }
      continue;
    }
    out.push(character);
    index += 1;
  }
  return out.join("");
}

/**
 * Detect credential material that a DDL export must never carry into an
 * inventory: `IDENTIFIED BY`, `WITH PASSWORD`, `SECRET =`, and connection
 * strings with inline passwords. Placeholders and secret references pass.
 */
export function containsSecretLikeSql(text: string): boolean {
  const patterns = [
    /\bIDENTIFIED\s+BY\s+(?:VALUES\s+)?("[^"]+"|'[^']+'|[^\s;,)]+)/gi,
    /\bWITH\s+PASSWORD\s*=\s*(N?'[^']*'|"[^"]+"|[^\s;,)]+)/gi,
    /\bPASSWORD\s*=\s*(N?'[^']*'|"[^"]+"|0x[0-9a-f]+)/gi,
    /\bSECRET\s*=\s*(N?'[^']*'|"[^"]+"|[^\s;,)]+)/gi,
    /\b(?:password|pwd)\s*=\s*([^;'"\s]+)\s*;/gi,
    /\b(?:api[-_]?key|access[-_]?token|client[-_]?secret)\s*=\s*('[^']+'|"[^"]+"|[^\s;,)]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!isPlaceholder(unquote(match[1] ?? ""))) return true;
    }
  }
  return hasUriCredentials(text);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("N'") && trimmed.endsWith("'")) return trimmed.slice(2, -1);
  return trimmed;
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    /^(?:\*+|\[?redacted\]?|<[^>]+>|env:|credentialref:|secretref:)/i.test(trimmed) ||
    /^\$\{[^}]+\}$/.test(trimmed) ||
    /^&&?[A-Za-z_][\w$#]*\.?$/.test(trimmed) ||
    /^:[A-Za-z_][\w$#]*$/.test(trimmed) ||
    /^%[^%]+%$/.test(trimmed) ||
    /^\$\([^)]+\)$/.test(trimmed)
  );
}

function hasUriCredentials(text: string): boolean {
  return /[a-z][a-z0-9+.-]*:\/\/[^/@\s'"]+:[^/@\s'"]+@/i.test(text);
}

function duplicatePathSet(inputs: readonly DatabaseArtifactInput[]): Set<string> {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.path, (counts.get(input.path) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path));
}

export function refusal(code: string, origin: string): DatabaseDiagnostic {
  return {
    level: "error",
    code,
    message: `Refused DDL export '${origin}'; collectors never retain credentials or evaluate SQL.`,
    coordinate: { origin },
  };
}

export function deduplicateDiagnostics(diagnostics: DatabaseDiagnostic[]): DatabaseDiagnostic[] {
  return [
    ...new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.coordinate?.origin ?? ""}:${diagnostic.coordinate?.pointer ?? ""}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  ];
}
