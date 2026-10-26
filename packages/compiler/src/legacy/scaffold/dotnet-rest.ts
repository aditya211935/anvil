/**
 * Recover HTTP endpoints from .NET source: ASP.NET Core / Web API attribute
 * routing (`[Route]`, `[HttpGet]`, …), Web API 2 convention routing against a
 * `MapHttpRoute` template, and ASMX `[WebMethod]` services. Source is read as
 * inert text; the scaffold never loads an assembly or runs code, and every
 * fact it emits names the line it was read from.
 */

import {
  type CSharpTypeDecl,
  classMembers,
  collectTypeDeclarations,
  lastSegment,
} from "./csharp-decls.js";
import { type CSharpText, decodeUtf8, lineAt, prepareCSharpText } from "./csharp-text.js";
import { type ControllerContext, scaffoldController } from "./dotnet-rest-controllers.js";
import {
  type AsmxDirective,
  type ConventionRouteTemplate,
  findConventionRouteTemplates,
  parseAsmxDirective,
} from "./dotnet-rest-routes.js";
import {
  buildTypeIndex,
  type DotnetTypeIndex,
  declaredReturnType,
  schemaForCSharpType,
} from "./dotnet-rest-types.js";
import {
  EMPTY_SCAFFOLD,
  type ScaffoldDiagnostic,
  type ScaffoldEndpoint,
  type ScaffoldResult,
  type ScaffoldSchema,
  type ScaffoldSourceMember,
} from "./model.js";

const MAX_MEMBER_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_MEMBERS = 5000;
const ASMX_FILE = /\.asmx$/i;
const SECRET_LIKE =
  /(?:password|passwd|pwd|secret|token|api[-_]?key|credential)\s*[=:]\s*[^\s/{}&]{4,}/i;

export function scaffoldDotnetRest(members: readonly ScaffoldSourceMember[]): ScaffoldResult {
  if (members.length === 0) return EMPTY_SCAFFOLD;
  const diagnostics: ScaffoldDiagnostic[] = [];
  const files: CSharpText[] = [];
  const asmx: AsmxDirective[] = [];
  let inspected = 0;
  let totalBytes = 0;
  const sorted = [...members].sort((left, right) => left.path.localeCompare(right.path));
  for (const member of sorted) {
    if (inspected >= MAX_MEMBERS) {
      diagnostics.push(bound(`more than ${MAX_MEMBERS} .NET members; the rest were not read`));
      break;
    }
    if (member.bytes.byteLength > MAX_MEMBER_BYTES) {
      diagnostics.push({
        level: "warning",
        code: "legacy/scaffold/dotnet/oversized_member",
        message: `'${member.path}' exceeds ${MAX_MEMBER_BYTES} bytes and was not read.`,
        evidence: { path: member.path },
      });
      continue;
    }
    totalBytes += member.bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) {
      diagnostics.push(
        bound(`more than ${MAX_TOTAL_BYTES} bytes of .NET source; the rest were not read`),
      );
      break;
    }
    const text = decodeUtf8(member.bytes);
    if (text === undefined) {
      diagnostics.push({
        level: "warning",
        code: "legacy/scaffold/dotnet/non_utf8_member",
        message: `'${member.path}' is not UTF-8 text and was not read.`,
        evidence: { path: member.path },
      });
      continue;
    }
    inspected += 1;
    if (ASMX_FILE.test(member.path)) {
      const { directive, reason } = parseAsmxDirective(member.path, text);
      if (directive) asmx.push(directive);
      else {
        diagnostics.push({
          level: "warning",
          code: "legacy/scaffold/asmx/invalid_activation_file",
          message: `'${member.path}' was not read as an ASMX activation file: ${reason}.`,
          evidence: { path: member.path },
        });
      }
      continue;
    }
    files.push(prepareCSharpText(member.path, text));
  }

  const declarations = files.flatMap((file) => collectTypeDeclarations(file));
  const index = buildTypeIndex(declarations);
  const conventionTemplates: ConventionRouteTemplate[] = files.flatMap((file) =>
    findConventionRouteTemplates(file),
  );
  const ctx: ControllerContext = { index, conventionTemplates, diagnostics };
  const endpoints: ScaffoldEndpoint[] = [];
  for (const decl of declarations) {
    if (decl.kind !== "class") continue;
    if (isWebService(decl)) endpoints.push(...scaffoldAsmxService(decl, asmx, index, diagnostics));
    else endpoints.push(...scaffoldController(decl, ctx));
  }
  disambiguateOperationIds(endpoints, diagnostics);
  return {
    endpoints: endpoints.filter((endpoint) => !refusesSecretLike(endpoint, diagnostics)),
    diagnostics,
    inputMembers: inspected,
  };
}

function bound(message: string): ScaffoldDiagnostic {
  return { level: "warning", code: "legacy/scaffold/dotnet/collection_bound_exceeded", message };
}

/* -------------------------------------------------------------------------- */
/* ASMX                                                                        */
/* -------------------------------------------------------------------------- */

function isWebService(decl: CSharpTypeDecl): boolean {
  return (
    decl.attributes.some((attribute) => attribute.name === "WebService") ||
    decl.bases.includes("WebService")
  );
}

function scaffoldAsmxService(
  decl: CSharpTypeDecl,
  directives: readonly AsmxDirective[],
  index: DotnetTypeIndex,
  diagnostics: ScaffoldDiagnostic[],
): ScaffoldEndpoint[] {
  const { methods } = classMembers(decl);
  const webMethods = methods.filter(
    (method) =>
      method.modifiers.includes("public") &&
      !method.modifiers.includes("static") &&
      method.attributes.some((attribute) => attribute.name === "WebMethod"),
  );
  if (webMethods.length === 0) return [];
  const qualified = decl.namespace ? `${decl.namespace}.${decl.name}` : decl.name;
  const activation = directives.find(
    (directive) =>
      directive.className === qualified ||
      (lastSegment(directive.className) === decl.name &&
        !directives.some((d) => d.className === qualified)),
  );
  if (!activation) {
    diagnostics.push({
      level: "warning",
      code: "legacy/scaffold/asmx/activation_file_missing",
      message: `[WebService] ${qualified} has no .asmx file with Class="${qualified}" in the source set; its URL path is unknown and its methods were left unmapped.`,
      evidence: {
        path: decl.file.path,
        line: lineAt(decl.file, decl.offset),
        construct: "[WebService]",
      },
    });
  }
  const serviceEvidence = {
    path: decl.file.path,
    line: lineAt(
      decl.file,
      decl.attributes.find((attribute) => attribute.name === "WebService")?.offset ?? decl.offset,
    ),
    construct: "[WebService]",
  };
  const fileName = activation?.path.split("/").at(-1) ?? "{service}.asmx";
  return webMethods.map((method): ScaffoldEndpoint => {
    const webMethod = method.attributes.find((attribute) => attribute.name === "WebMethod");
    const messageName = webMethod?.named.get("MessageName");
    const segment =
      messageName?.kind === "string" && messageName.value.length > 0
        ? messageName.value
        : method.name;
    const methodEvidence = {
      path: decl.file.path,
      line: lineAt(decl.file, webMethod?.offset ?? method.offset),
      construct: "[WebMethod]",
    };
    const properties: Record<string, ScaffoldSchema> = {};
    const required: string[] = [];
    for (const parameter of method.parameters) {
      properties[parameter.name] = schemaForCSharpType(parameter.type, index);
      required.push(parameter.name);
    }
    const declared = declaredReturnType(method.returnType);
    return {
      framework: "asmx",
      ...(activation ? { method: "post" as const } : {}),
      path: activation ? `/${fileName}/${segment}` : `~/{service}.asmx/${segment}`,
      operationId: `${decl.name}.${method.name}`,
      handler: { type: decl.name, member: method.name },
      parameters: [],
      ...(method.parameters.length > 0
        ? {
            requestBody: {
              contentTypes: [],
              schema: { type: "object" as const, properties, required },
              required: true,
              evidence: [methodEvidence],
            },
          }
        : {}),
      ...(declared !== undefined
        ? {
            response: {
              contentTypes: [],
              schema: schemaForCSharpType(declared, index),
              required: false,
              evidence: [
                {
                  path: decl.file.path,
                  line: lineAt(decl.file, method.offset),
                  construct: "return_type",
                },
              ],
            },
          }
        : {}),
      evidence: [
        serviceEvidence,
        methodEvidence,
        ...(activation
          ? [{ path: activation.path, line: activation.line, construct: "WebService directive" }]
          : []),
      ],
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Identity and refusal                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `<Class>.<Method>` is unique unless the method is overloaded or one action
 * declares several routes or verbs. Then every endpoint in the group gets a
 * suffix: the verb when the verbs differ, else its source-order index.
 */
function disambiguateOperationIds(
  endpoints: ScaffoldEndpoint[],
  diagnostics: ScaffoldDiagnostic[],
): void {
  const groups = new Map<string, ScaffoldEndpoint[]>();
  for (const endpoint of endpoints) {
    const group = groups.get(endpoint.operationId) ?? [];
    group.push(endpoint);
    groups.set(endpoint.operationId, group);
  }
  for (const [base, group] of groups) {
    if (group.length < 2) continue;
    const verbs = group.map((endpoint) => endpoint.method);
    const byVerb =
      verbs.every((verb) => verb !== undefined) && new Set(verbs).size === verbs.length;
    group.forEach((endpoint, position) => {
      endpoint.operationId = byVerb ? `${base}_${endpoint.method}` : `${base}_${position + 1}`;
    });
    diagnostics.push({
      level: "info",
      code: `legacy/scaffold/${group[0]?.framework ?? "aspnet_core"}/operation_id_disambiguated`,
      message: `${base} is addressed by ${group.length} endpoints (overloads or multiple routes); they were numbered ${byVerb ? "by HTTP method" : "in source order"}.`,
      ...(group[0]?.evidence[0] ? { evidence: group[0].evidence[0] } : {}),
    });
  }
}

/** Refuse an endpoint whose declared strings would carry a secret-like value into the draft. */
function refusesSecretLike(endpoint: ScaffoldEndpoint, diagnostics: ScaffoldDiagnostic[]): boolean {
  const strings = [
    endpoint.path,
    ...endpoint.parameters.map((parameter) => parameter.name),
    ...(endpoint.requestBody?.contentTypes ?? []),
    ...(endpoint.response?.contentTypes ?? []),
  ];
  if (!strings.some((value) => SECRET_LIKE.test(value))) return false;
  diagnostics.push({
    level: "error",
    code: `legacy/scaffold/${endpoint.framework}/secret_like_value_refused`,
    message: `${endpoint.handler.type}.${endpoint.handler.member} declares a route or name that looks like a credential; the endpoint was refused rather than written into the draft.`,
    ...(endpoint.evidence[0] ? { evidence: endpoint.evidence[0] } : {}),
  });
  return true;
}
