/**
 * The scaffold model: HTTP endpoints recovered from application source that
 * has no machine-readable contract (a JAX-RS or Spring MVC controller, an
 * ASP.NET attribute-routed controller, a `web.xml` servlet mapping). Each
 * endpoint is an exact, evidence-pinned reading of the source — the path
 * template the framework would route, the HTTP method it declares, the
 * parameters it binds — and never a guess at what the operation *means*.
 *
 * A scaffold is lowered into an OpenAPI draft (`openapi-draft.ts`) that the
 * ordinary compiler then classifies, so the same three-surface pipeline that
 * reads a vendor's published specification reads a legacy estate's source.
 * The draft keeps the compiler honest the same way: there is no description,
 * no example, and no success semantics beyond what the source declared.
 */

export type ScaffoldFramework =
  | "jaxrs"
  | "spring_mvc"
  | "servlet"
  | "aspnet_webapi"
  | "aspnet_core"
  | "asmx";

export type ScaffoldHttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch";

export const SCAFFOLD_HTTP_METHODS: readonly ScaffoldHttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
];

/** Where in the source set a fact was read. Lines are 1-based. */
export interface ScaffoldEvidence {
  path: string;
  line?: number;
  /** A framework-specific coordinate, e.g. `@Path` or `[HttpGet]`. */
  construct?: string;
}

/**
 * A deliberately small JSON-Schema subset: enough to record the declared
 * parameter and payload types faithfully, never enough to invent structure
 * the source did not declare.
 */
export interface ScaffoldSchema {
  type?: "string" | "integer" | "number" | "boolean" | "array" | "object";
  format?: string;
  items?: ScaffoldSchema;
  enum?: string[];
  properties?: Record<string, ScaffoldSchema>;
  required?: string[];
  additionalProperties?: boolean;
  /** The source language's declared type, verbatim (`java.util.UUID`, `int?`). */
  sourceType?: string;
}

export interface ScaffoldParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: ScaffoldSchema;
  evidence: ScaffoldEvidence[];
}

export interface ScaffoldPayload {
  /** Media types the source declared (`@Consumes`, `[Produces]`); empty when it declared none. */
  contentTypes: string[];
  schema: ScaffoldSchema;
  required: boolean;
  evidence: ScaffoldEvidence[];
}

export interface ScaffoldEndpoint {
  framework: ScaffoldFramework;
  /** Absent when the source maps a path but no method (a servlet mapping). */
  method?: ScaffoldHttpMethod;
  /** OpenAPI path template: `/orders/{orderId}`. */
  path: string;
  /** Deterministic from the handler, e.g. `OrderResource.getOrder`; unique within a scaffold. */
  operationId: string;
  /** The source's own handler coordinate. */
  handler: { type: string; member: string };
  parameters: ScaffoldParameter[];
  requestBody?: ScaffoldPayload;
  response?: ScaffoldPayload;
  /** A read declared by the source itself (`[HttpGet]`, `@GET`) is `read`; every
   *  other method keeps the compiler's own HTTP-method classification. */
  evidence: ScaffoldEvidence[];
}

export interface ScaffoldDiagnostic {
  level: "error" | "warning" | "info";
  /** `legacy/scaffold/<framework>/<reason>` */
  code: string;
  message: string;
  evidence?: ScaffoldEvidence;
}

export interface ScaffoldSourceMember {
  path: string;
  bytes: Uint8Array;
}

export interface ScaffoldResult {
  endpoints: ScaffoldEndpoint[];
  diagnostics: ScaffoldDiagnostic[];
  /** Members this scaffold actually read, for the report. */
  inputMembers: number;
}

export const EMPTY_SCAFFOLD: ScaffoldResult = { endpoints: [], diagnostics: [], inputMembers: 0 };
