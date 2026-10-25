import { createHash } from "node:crypto";
import type {
  MainframeArtifactEvidence,
  MainframeArtifactInput,
  MainframeDiagnostic,
} from "./model.js";

const MAX_FILES = 512;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const SAFE_PATH = /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0]+$/;

export interface AcceptedMainframeArtifact {
  path: string;
  raw: Uint8Array;
  text: string;
  evidence: MainframeArtifactEvidence;
}

export function isCopybookPath(path: string): boolean {
  return /\.(?:cpy|cob|cbl|cpb)$/i.test(path);
}

/**
 * Accept bounded, UTF-8 text members. EBCDIC members must be transcoded by the
 * exporting pipeline first; this collector never guesses a code page. Members
 * that carry a password-like operand are refused as a whole, because JCL has
 * no safe way to separate the credential from the statement that carries it.
 */
export function acceptMainframeArtifacts(inputs: readonly MainframeArtifactInput[]): {
  artifacts: AcceptedMainframeArtifact[];
  diagnostics: MainframeDiagnostic[];
} {
  if (inputs.length > MAX_FILES) {
    return {
      artifacts: [],
      diagnostics: [
        {
          level: "error",
          code: "mainframe/too_many_artifacts",
          message: `Refused ${inputs.length} artifacts; the collector limit is ${MAX_FILES}.`,
        },
      ],
    };
  }
  const duplicatePaths = duplicatePathSet(inputs);
  const diagnostics: MainframeDiagnostic[] = [];
  const artifacts: AcceptedMainframeArtifact[] = [];
  let totalBytes = 0;
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) {
    if (input.path.length > 4096 || !SAFE_PATH.test(input.path)) {
      diagnostics.push(refusal("mainframe/unsafe_artifact_path", input.path));
      continue;
    }
    if (duplicatePaths.has(input.path)) {
      diagnostics.push(refusal("mainframe/duplicate_artifact_path", input.path));
      continue;
    }
    const raw =
      typeof input.bytes === "string" ? new TextEncoder().encode(input.bytes) : input.bytes;
    totalBytes += raw.byteLength;
    if (raw.byteLength > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push(refusal("mainframe/oversized_artifact", input.path));
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      diagnostics.push({
        level: "error",
        code: "mainframe/non_utf8_artifact",
        message: `Refused mainframe artifact '${input.path}': not UTF-8 text. Transcode EBCDIC members before collection.`,
        coordinate: { origin: input.path },
      });
      continue;
    }
    if (text.includes("\0")) {
      diagnostics.push(refusal("mainframe/binary_artifact", input.path));
      continue;
    }
    if (!isCopybookPath(input.path) && containsSecretLikeOperand(text)) {
      diagnostics.push({
        level: "error",
        code: "mainframe/secret_like_value",
        message: `Refused mainframe artifact '${input.path}': it carries a PASSWORD/PASSWD operand. Remove the credential before collection.`,
        coordinate: { origin: input.path },
      });
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
        mediaType: "text/plain",
        role: evidenceRole(input.path, text),
      },
    });
  }
  return { artifacts, diagnostics };
}

function containsSecretLikeOperand(text: string): boolean {
  return /(?:^|[\s,(/])(?:PASSWORD|PASSWD|PASSWRD|PWD)\s*=/i.test(text);
}

function evidenceRole(path: string, text: string): MainframeArtifactEvidence["role"] {
  if (isCopybookPath(path)) return "copybook";
  if (
    /^\/\/[A-Z0-9@#$]{1,8}\s+PROC\b/im.test(text) &&
    !/^\/\/[A-Z0-9@#$]{1,8}\s+JOB\b/im.test(text)
  )
    return "jcl_procedure";
  if (/^\/\/[A-Z0-9@#$]{1,8}\s+JOB\b/im.test(text)) return "jcl_job";
  return "other";
}

function duplicatePathSet(inputs: readonly MainframeArtifactInput[]): Set<string> {
  const counts = new Map<string, number>();
  for (const input of inputs) counts.set(input.path, (counts.get(input.path) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([path]) => path));
}

function refusal(code: string, origin: string): MainframeDiagnostic {
  return {
    level: "error",
    code,
    message: `Refused mainframe artifact '${origin}'.`,
    coordinate: { origin },
  };
}
