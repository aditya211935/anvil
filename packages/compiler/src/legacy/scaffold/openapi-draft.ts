import { hashCanonical } from "@anvil/air";
import {
  SCAFFOLD_HTTP_METHODS,
  type ScaffoldDiagnostic,
  type ScaffoldEndpoint,
  type ScaffoldEvidence,
  type ScaffoldHttpMethod,
  type ScaffoldPayload,
  type ScaffoldResult,
  type ScaffoldSchema,
} from "./model.js";

/** Vendor extension carried on every scaffolded operation and the document. */
export const SCAFFOLD_EXTENSION = "x-anvil-scaffold";
/** Vendor extension: the exact source coordinates each operation was read from. */
export const SCAFFOLD_EVIDENCE_EXTENSION = "x-anvil-evidence";

export interface OpenApiDraftInput {
  title: string;
  /** Recorded as `info.version`; the content hash is always recorded beside it. */
  version?: string;
  scaffold: ScaffoldResult;
}

export interface OpenApiDraft {
  document: Record<string, unknown>;
  /** Endpoints that declared no HTTP method; recorded on the document, never
   *  compiled as operations, because a method would have to be guessed. */
  unmapped: ScaffoldEndpoint[];
  diagnostics: ScaffoldDiagnostic[];
  contentHash: `sha256:${string}`;
}

const DRAFT_SCHEMA_VERSION = 1;

/**
 * Lower a scaffold into an OpenAPI 3.0.3 document the ordinary compiler reads.
 *
 * The document is deterministic for a given scaffold: paths, methods,
 * parameters and extension arrays are sorted, and the content hash recorded on
 * it is of the draft itself. Nothing here is invented: a path without a method
 * is kept as `x-anvil-scaffold.unmapped`, a parameter without a declared type
 * is a string, a payload without a declared shape is an open object recording
 * the source type, and no operation gets a description or example the source
 * did not state. Classification stays the compiler's job, from the method.
 */
export function emitOpenApiDraft(input: OpenApiDraftInput): OpenApiDraft {
  const diagnostics: ScaffoldDiagnostic[] = [...input.scaffold.diagnostics];
  const endpoints = [...input.scaffold.endpoints].sort(compareEndpoints);
  const unmapped = endpoints.filter((endpoint) => endpoint.method === undefined);
  const mapped = endpoints.filter(
    (endpoint): endpoint is ScaffoldEndpoint & { method: ScaffoldHttpMethod } =>
      endpoint.method !== undefined,
  );

  const seen = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of mapped) {
    if (seen.has(endpoint.operationId)) {
      diagnostics.push({
        level: "error",
        code: `legacy/scaffold/${endpoint.framework}/duplicate_operation_id`,
        message: `Two endpoints scaffold to operationId '${endpoint.operationId}'; the second was dropped. Scaffolds must address handlers uniquely.`,
        ...(endpoint.evidence[0] ? { evidence: endpoint.evidence[0] } : {}),
      });
      continue;
    }
    const existing = paths[endpoint.path]?.[endpoint.method];
    if (existing) {
      diagnostics.push({
        level: "error",
        code: `legacy/scaffold/${endpoint.framework}/duplicate_route`,
        message: `${endpoint.method.toUpperCase()} ${endpoint.path} is declared by more than one handler; only the first (by operationId) was kept.`,
        ...(endpoint.evidence[0] ? { evidence: endpoint.evidence[0] } : {}),
      });
      continue;
    }
    seen.add(endpoint.operationId);
    paths[endpoint.path] = { ...paths[endpoint.path], [endpoint.method]: operationFor(endpoint) };
  }

  const sortedPaths: Record<string, unknown> = {};
  for (const path of Object.keys(paths).sort()) {
    const byMethod = paths[path] ?? {};
    const ordered: Record<string, unknown> = {};
    for (const method of SCAFFOLD_HTTP_METHODS) {
      if (byMethod[method] !== undefined) ordered[method] = byMethod[method];
    }
    sortedPaths[path] = ordered;
  }

  const frameworks = [...new Set(endpoints.map((endpoint) => endpoint.framework))].sort();
  const body = {
    openapi: "3.0.3",
    info: {
      title: input.title,
      version: input.version ?? "0.0.0-scaffold",
      description:
        "Scaffolded by Anvil from application source without a published contract. " +
        "Every operation records the source coordinates it was read from; none carries " +
        "business semantics the source did not declare. Review before approving anything.",
    },
    paths: sortedPaths,
    [SCAFFOLD_EXTENSION]: {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      frameworks,
      inputMembers: input.scaffold.inputMembers,
      operations: seen.size,
      unmapped: unmapped.map((endpoint) => ({
        framework: endpoint.framework,
        path: endpoint.path,
        handler: endpoint.handler,
        evidence: sortedEvidence(endpoint.evidence),
      })),
      diagnostics: [...diagnostics].sort(compareDiagnostics),
    },
  };
  const hex = hashCanonical(body);
  const document = {
    ...body,
    [SCAFFOLD_EXTENSION]: { ...body[SCAFFOLD_EXTENSION], contentHash: `sha256:${hex}` },
  };
  return { document, unmapped, diagnostics, contentHash: `sha256:${hex}` };
}

function operationFor(endpoint: ScaffoldEndpoint & { method: ScaffoldHttpMethod }) {
  const parameters = [...endpoint.parameters]
    .sort((left, right) => left.in.localeCompare(right.in) || left.name.localeCompare(right.name))
    .map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.in === "path" ? true : parameter.required,
      schema: schemaFor(parameter.schema),
      [SCAFFOLD_EVIDENCE_EXTENSION]: sortedEvidence(parameter.evidence),
    }));
  const pathParams = new Set(
    [...endpoint.path.matchAll(/(?<!\$)\{([^}]+)\}/g)].map((match) => match[1] ?? ""),
  );
  for (const name of [...pathParams].sort()) {
    if (!parameters.some((parameter) => parameter.in === "path" && parameter.name === name)) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        [SCAFFOLD_EVIDENCE_EXTENSION]: sortedEvidence(endpoint.evidence),
      });
    }
  }
  return {
    operationId: endpoint.operationId,
    summary: `${endpoint.handler.type}.${endpoint.handler.member}`,
    tags: [endpoint.handler.type],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(endpoint.requestBody ? { requestBody: requestBodyFor(endpoint.requestBody) } : {}),
    responses: responsesFor(endpoint.response),
    [SCAFFOLD_EXTENSION]: {
      framework: endpoint.framework,
      handler: endpoint.handler,
      basis: "source_declaration",
    },
    [SCAFFOLD_EVIDENCE_EXTENSION]: sortedEvidence(endpoint.evidence),
  };
}

function requestBodyFor(payload: ScaffoldPayload) {
  const contentTypes =
    payload.contentTypes.length > 0 ? payload.contentTypes : ["application/json"];
  const content: Record<string, unknown> = {};
  for (const type of [...new Set(contentTypes)].sort()) {
    content[type] = { schema: schemaFor(payload.schema) };
  }
  return {
    required: payload.required,
    content,
    [SCAFFOLD_EVIDENCE_EXTENSION]: sortedEvidence(payload.evidence),
  };
}

function responsesFor(payload: ScaffoldPayload | undefined) {
  if (!payload) {
    return { default: { description: "Response shape not declared by the source." } };
  }
  const contentTypes =
    payload.contentTypes.length > 0 ? payload.contentTypes : ["application/json"];
  const content: Record<string, unknown> = {};
  for (const type of [...new Set(contentTypes)].sort()) {
    content[type] = { schema: schemaFor(payload.schema) };
  }
  return {
    "200": {
      description: "Declared response type.",
      content,
      [SCAFFOLD_EVIDENCE_EXTENSION]: sortedEvidence(payload.evidence),
    },
  };
}

/** Project the scaffold subset onto JSON Schema, recording the source type. */
export function schemaFor(schema: ScaffoldSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type;
  if (schema.format) out.format = schema.format;
  if (schema.enum) out.enum = [...schema.enum];
  if (schema.items) out.items = schemaFor(schema.items);
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const name of Object.keys(schema.properties).sort()) {
      const property = schema.properties[name];
      if (property) properties[name] = schemaFor(property);
    }
    out.properties = properties;
  }
  if (schema.required) out.required = [...schema.required].sort();
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  if (schema.type === "object" && !schema.properties && schema.additionalProperties === undefined) {
    // An undeclared shape stays open and says so; it is never narrowed on a guess.
    out.additionalProperties = true;
  }
  if (schema.sourceType) out["x-anvil-source-type"] = schema.sourceType;
  if (!schema.type && !schema.enum) out.type = "string";
  return out;
}

function sortedEvidence(evidence: readonly ScaffoldEvidence[]): ScaffoldEvidence[] {
  return [...evidence]
    .map((item) => ({
      path: item.path,
      ...(item.line !== undefined ? { line: item.line } : {}),
      ...(item.construct !== undefined ? { construct: item.construct } : {}),
    }))
    .sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.line ?? 0) - (right.line ?? 0) ||
        (left.construct ?? "").localeCompare(right.construct ?? ""),
    );
}

function compareEndpoints(left: ScaffoldEndpoint, right: ScaffoldEndpoint): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.method ?? "").localeCompare(right.method ?? "") ||
    left.operationId.localeCompare(right.operationId)
  );
}

function compareDiagnostics(left: ScaffoldDiagnostic, right: ScaffoldDiagnostic): number {
  return (
    left.code.localeCompare(right.code) ||
    (left.evidence?.path ?? "").localeCompare(right.evidence?.path ?? "") ||
    (left.evidence?.line ?? 0) - (right.evidence?.line ?? 0) ||
    left.message.localeCompare(right.message)
  );
}
