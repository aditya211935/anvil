/**
 * ASP.NET Core / ASP.NET Web API controllers → scaffold endpoints. Attribute
 * routing is read exactly; Web API 2 convention routing is expanded only
 * against a `MapHttpRoute` template found in the same source set; a binding
 * source the source did not state is recorded as `inferred_binding` so the
 * reader can tell convention from declaration.
 */

import {
  type CSharpMethod,
  type CSharpParameter,
  type CSharpTypeDecl,
  classMembers,
} from "./csharp-decls.js";
import type { CSharpAttribute, CSharpText } from "./csharp-text.js";
import { lineAt } from "./csharp-text.js";
import {
  type ConventionRouteTemplate,
  combineRouteTemplates,
  expandRouteTokens,
  type LoweredRoute,
  lowerRouteTemplate,
  type RouteToken,
  schemaForConstraints,
} from "./dotnet-rest-routes.js";
import {
  type DotnetTypeIndex,
  declaredReturnType,
  isSimpleCollection,
  isSimpleType,
  parseCSharpType,
  schemaForCSharpType,
} from "./dotnet-rest-types.js";
import type {
  ScaffoldDiagnostic,
  ScaffoldEndpoint,
  ScaffoldEvidence,
  ScaffoldFramework,
  ScaffoldHttpMethod,
  ScaffoldParameter,
  ScaffoldPayload,
  ScaffoldSchema,
} from "./model.js";

export interface ControllerContext {
  index: DotnetTypeIndex;
  conventionTemplates: readonly ConventionRouteTemplate[];
  diagnostics: ScaffoldDiagnostic[];
}

type MvcFramework = Extract<ScaffoldFramework, "aspnet_core" | "aspnet_webapi">;

interface Verb {
  method: ScaffoldHttpMethod;
  template?: string;
  evidence: ScaffoldEvidence;
}

interface ActionRoute {
  method?: ScaffoldHttpMethod;
  template?: string;
  evidence: ScaffoldEvidence[];
}

const VERB_ATTRIBUTES: Record<string, ScaffoldHttpMethod> = {
  HttpGet: "get",
  HttpPost: "post",
  HttpPut: "put",
  HttpDelete: "delete",
  HttpPatch: "patch",
  HttpHead: "head",
  HttpOptions: "options",
};
const VERB_NAMES = new Set<string>(["get", "post", "put", "delete", "patch", "head", "options"]);
const ACTION_NAME_PREFIX = /^(get|post|put|delete|patch|head|options)/i;
const CONTROLLER_BASES = new Set(["ControllerBase", "Controller", "ApiController"]);
const INFRASTRUCTURE_TYPES = new Set([
  "CancellationToken",
  "HttpContext",
  "HttpRequest",
  "HttpResponse",
  "HttpRequestMessage",
  "ClaimsPrincipal",
  "ModelStateDictionary",
  "IFormCollection",
]);
const FORM_FILE_TYPES = new Set(["IFormFile", "IFormFileCollection"]);

export function isController(decl: CSharpTypeDecl, methods: readonly CSharpMethod[]): boolean {
  if (decl.kind !== "class" || decl.modifiers.includes("abstract") || !decl.body) return false;
  if (has(decl.attributes, "NonController")) return false;
  if (has(decl.attributes, "ApiController") || has(decl.attributes, "Route")) return true;
  if (has(decl.attributes, "RoutePrefix")) return true;
  if (decl.bases.some((base) => CONTROLLER_BASES.has(base))) return true;
  return (
    decl.name.endsWith("Controller") &&
    methods.some((method) =>
      method.attributes.some(
        (attribute) =>
          attribute.name in VERB_ATTRIBUTES ||
          attribute.name === "Route" ||
          attribute.name === "AcceptVerbs",
      ),
    )
  );
}

export function scaffoldController(
  decl: CSharpTypeDecl,
  ctx: ControllerContext,
): ScaffoldEndpoint[] {
  const { methods } = classMembers(decl);
  if (!isController(decl, methods)) return [];
  const framework: MvcFramework =
    decl.bases.includes("ApiController") || has(decl.attributes, "RoutePrefix")
      ? "aspnet_webapi"
      : "aspnet_core";
  const controllerName = decl.name.replace(/Controller$/, "");
  const area = stringArgs(decl.attributes, "Area")[0];
  const controllerTemplates =
    framework === "aspnet_core"
      ? all(decl.attributes, "Route").map((attribute) => ({
          template: attribute.positional[0]?.kind === "string" ? attribute.positional[0].value : "",
          evidence: evidence(decl.file, attribute.offset, "[Route]"),
        }))
      : all(decl.attributes, "RoutePrefix")
          .filter((attribute) => attribute.positional[0]?.kind === "string")
          .map((attribute) => ({
            template: (attribute.positional[0] as { value: string }).value,
            evidence: evidence(decl.file, attribute.offset, "[RoutePrefix]"),
          }));
  const endpoints: ScaffoldEndpoint[] = [];
  for (const method of methods) {
    if (!method.modifiers.includes("public") || method.modifiers.includes("static")) continue;
    if (has(method.attributes, "NonAction")) continue;
    const action = { decl, method, framework, controllerName, area, controllerTemplates, ctx };
    const routes =
      framework === "aspnet_core" ? coreActionRoutes(action) : webApiActionRoutes(action);
    for (const route of routes) endpoints.push(...endpointsFor(action, route));
  }
  return endpoints;
}

interface Action {
  decl: CSharpTypeDecl;
  method: CSharpMethod;
  framework: MvcFramework;
  controllerName: string;
  area: string | undefined;
  controllerTemplates: { template: string; evidence: ScaffoldEvidence }[];
  ctx: ControllerContext;
}

function declaredVerbs(action: Action): { verbs: Verb[]; routes: CSharpAttribute[] } {
  const { method, decl } = action;
  const verbs: Verb[] = [];
  for (const attribute of method.attributes) {
    const verb = VERB_ATTRIBUTES[attribute.name];
    if (verb) {
      const template =
        attribute.positional[0]?.kind === "string" ? attribute.positional[0].value : undefined;
      verbs.push({
        method: verb,
        ...(template !== undefined ? { template } : {}),
        evidence: evidence(decl.file, attribute.offset, `[${attribute.name}]`),
      });
    } else if (attribute.name === "AcceptVerbs") {
      const route = attribute.named.get("Route");
      for (const argument of attribute.positional) {
        const name = argument.value.toLowerCase();
        if (argument.kind !== "string" || !VERB_NAMES.has(name)) continue;
        verbs.push({
          method: name as ScaffoldHttpMethod,
          ...(route?.kind === "string" ? { template: route.value } : {}),
          evidence: evidence(decl.file, attribute.offset, "[AcceptVerbs]"),
        });
      }
    }
  }
  return { verbs, routes: all(method.attributes, "Route") };
}

function coreActionRoutes(action: Action): ActionRoute[] {
  const { verbs, routes } = declaredVerbs(action);
  const { decl } = action;
  const out: ActionRoute[] = [];
  for (const verb of verbs.filter((verb) => verb.template !== undefined)) {
    out.push({ method: verb.method, template: verb.template as string, evidence: [verb.evidence] });
  }
  const bare = verbs.filter((verb) => verb.template === undefined);
  const routeTemplates = routes.map((attribute) => ({
    template: attribute.positional[0]?.kind === "string" ? attribute.positional[0].value : "",
    evidence: evidence(decl.file, attribute.offset, "[Route]"),
  }));
  if (routeTemplates.length > 0) {
    for (const route of routeTemplates) {
      if (bare.length === 0) {
        out.push({ template: route.template, evidence: [route.evidence] });
      }
      for (const verb of bare) {
        out.push({
          method: verb.method,
          template: route.template,
          evidence: [route.evidence, verb.evidence],
        });
      }
    }
  } else {
    for (const verb of bare) out.push({ method: verb.method, evidence: [verb.evidence] });
  }
  if (out.length === 0 && action.controllerTemplates.length > 0) {
    // A public method on an attribute-routed controller with no attribute of
    // its own matches the controller template for every verb: a path, no method.
    out.push({ evidence: [evidence(decl.file, action.method.offset, "public_action")] });
  }
  return out;
}

function webApiActionRoutes(action: Action): ActionRoute[] {
  const { verbs: declared, routes } = declaredVerbs(action);
  const { decl, method } = action;
  const prefix = ACTION_NAME_PREFIX.exec(method.name);
  const verbs: Verb[] =
    declared.length > 0
      ? declared
      : prefix
        ? [
            {
              method: (prefix[1] as string).toLowerCase() as ScaffoldHttpMethod,
              evidence: evidence(decl.file, method.offset, "action_name_prefix"),
            },
          ]
        : [];
  const out: ActionRoute[] = [];
  const templates = routes
    .filter((attribute) => attribute.positional[0]?.kind === "string")
    .map((attribute) => ({
      template: (attribute.positional[0] as { value: string }).value,
      evidence: evidence(decl.file, attribute.offset, "[Route]"),
    }));
  for (const verb of declared.filter((verb) => verb.template !== undefined)) {
    templates.push({ template: verb.template as string, evidence: verb.evidence });
  }
  if (templates.length > 0) {
    for (const route of templates) {
      if (verbs.length === 0) {
        out.push({ template: route.template, evidence: [route.evidence] });
        action.ctx.diagnostics.push(verbNotDeclared(action));
      }
      for (const verb of verbs) {
        out.push({
          method: verb.method,
          template: route.template,
          evidence: [route.evidence, verb.evidence],
        });
      }
    }
    return out;
  }
  // Convention routing: only a template found in the source set is expanded.
  if (action.ctx.conventionTemplates.length === 0) {
    action.ctx.diagnostics.push({
      level: "warning",
      code: "legacy/scaffold/aspnet_webapi/route_template_unknown",
      message: `${decl.name}.${method.name} is convention-routed but no 'MapHttpRoute' template was found in the source set; its path is unknown and was not guessed.`,
      evidence: verbs[0]?.evidence ?? evidence(decl.file, method.offset, "public_action"),
    });
    for (const verb of verbs) out.push({ method: verb.method, evidence: [verb.evidence] });
    if (verbs.length === 0)
      out.push({ evidence: [evidence(decl.file, method.offset, "public_action")] });
    return out;
  }
  for (const convention of action.ctx.conventionTemplates) {
    const template = conventionTemplateFor(action, convention);
    const conventionEvidence = evidence(convention.file, convention.offset, "MapHttpRoute");
    if (verbs.length === 0) {
      out.push({ template, evidence: [conventionEvidence] });
      action.ctx.diagnostics.push(verbNotDeclared(action));
    }
    for (const verb of verbs) {
      out.push({ method: verb.method, template, evidence: [conventionEvidence, verb.evidence] });
    }
  }
  return out;
}

function verbNotDeclared(action: Action): ScaffoldDiagnostic {
  return {
    level: "warning",
    code: "legacy/scaffold/aspnet_webapi/verb_not_declared",
    message: `${action.decl.name}.${action.method.name} declares no HTTP verb attribute and its name carries no verb prefix; Web API's POST default is a convention this scaffold does not assert.`,
    evidence: evidence(action.decl.file, action.method.offset, "public_action"),
  };
}

/** Expand a `MapHttpRoute` template for one action, dropping optional tokens the action does not bind. */
function conventionTemplateFor(action: Action, convention: ConventionRouteTemplate): string {
  const bound = new Set(
    action.method.parameters.map((parameter) => bindingName(parameter).toLowerCase()),
  );
  return convention.template
    .split("/")
    .filter((segment) => {
      const token = /^\{([A-Za-z_]\w*)\??\}$/.exec(segment);
      if (!token) return true;
      const name = (token[1] as string).toLowerCase();
      if (name === "controller" || name === "action") return true;
      return bound.has(name) || !convention.optional.has(token[1] as string);
    })
    .map((segment) =>
      segment
        .replace(/\{controller\}/i, action.controllerName)
        .replace(/\{action\}/i, action.method.name),
    )
    .join("/");
}

function endpointsFor(action: Action, route: ActionRoute): ScaffoldEndpoint[] {
  const { decl, method, framework, ctx } = action;
  const base = {
    framework,
    operationId: `${decl.name}.${method.name}`,
    handler: { type: decl.name, member: method.name },
  };
  const controllerTemplates =
    action.controllerTemplates.length > 0 ? action.controllerTemplates : [undefined];
  const endpoints: ScaffoldEndpoint[] = [];
  for (const controller of controllerTemplates) {
    const combined = combineRouteTemplates(controller?.template, route.template);
    const routeEvidence = [...(controller ? [controller.evidence] : []), ...route.evidence];
    if (combined === undefined) {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${framework}/route_template_unknown`,
        message: `${decl.name}.${method.name} declares ${route.method ? `[${route.method.toUpperCase()}]` : "an action"} without a route template and the controller declares none; the path comes from conventional routing this source set does not state.`,
        evidence: route.evidence[0] ?? evidence(decl.file, method.offset, "public_action"),
      });
      endpoints.push({
        ...base,
        path: `~/{controller}/{action}`,
        parameters: [],
        evidence: routeEvidence,
      });
      continue;
    }
    const expanded = expandRouteTokens(combined, {
      controller: action.controllerName,
      action: method.name,
      ...(action.area !== undefined ? { area: action.area } : {}),
    });
    if (expanded.unresolved.length > 0) {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${framework}/route_token_unresolved`,
        message: `${decl.name}.${method.name}: route token(s) ${expanded.unresolved.join(", ")} have no value in the source set; the route was left unmapped.`,
        evidence: route.evidence[0] ?? evidence(decl.file, method.offset, "public_action"),
      });
      endpoints.push({
        ...base,
        path: `~/${combined.replace(/^\/+/, "")}`,
        parameters: [],
        evidence: routeEvidence,
      });
      continue;
    }
    const lowered = lowerRouteTemplate(expanded.template);
    if (lowered.invalid) {
      ctx.diagnostics.push({
        level: "error",
        code: `legacy/scaffold/${framework}/invalid_route_template`,
        message: `${decl.name}.${method.name}: route template '${expanded.template}' was refused: ${lowered.invalid}.`,
        evidence: route.evidence[0] ?? evidence(decl.file, method.offset, "public_action"),
      });
      continue;
    }
    if (route.method === undefined) {
      ctx.diagnostics.push({
        level: "info",
        code: `legacy/scaffold/${framework}/any_verb_route`,
        message: `${decl.name}.${method.name} maps '${lowered.path}' without declaring an HTTP method; it is recorded as unmapped rather than given one.`,
        evidence: route.evidence[0] ?? evidence(decl.file, method.offset, "public_action"),
      });
      endpoints.push({ ...base, path: lowered.path, parameters: [], evidence: routeEvidence });
      continue;
    }
    endpoints.push(buildEndpoint(action, route.method, lowered, routeEvidence, base));
  }
  return endpoints;
}

function buildEndpoint(
  action: Action,
  verb: ScaffoldHttpMethod,
  lowered: LoweredRoute,
  routeEvidence: ScaffoldEvidence[],
  base: Pick<ScaffoldEndpoint, "framework" | "operationId" | "handler">,
): ScaffoldEndpoint {
  const { decl, method, ctx } = action;
  const bound = classifyParameters(action, lowered.tokens, routeEvidence);
  const parameters = bound.parameters;
  for (const token of lowered.tokens) {
    const label = `${decl.name}.${method.name}`;
    if (token.optional) {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${action.framework}/optional_path_parameter`,
        message: `${label}: route parameter '{${token.name}?}' is optional in ASP.NET but OpenAPI path parameters are always required; the draft requires it.`,
        evidence: routeEvidence[routeEvidence.length - 1] as ScaffoldEvidence,
      });
    }
    if (token.catchAll) {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${action.framework}/catch_all_parameter`,
        message: `${label}: route parameter '{*${token.name}}' is a catch-all; the draft records it as a single path parameter '{${token.name}}'.`,
        evidence: routeEvidence[routeEvidence.length - 1] as ScaffoldEvidence,
      });
    }
    if (
      !parameters.some((p) => p.in === "path" && p.name.toLowerCase() === token.name.toLowerCase())
    ) {
      parameters.push({
        name: token.name,
        in: "path",
        required: !token.optional,
        schema: {
          ...(schemaForConstraints(token.constraints) ?? { type: "string" }),
          sourceType: `{${token.name}${token.constraints.length > 0 ? `:${token.constraints.join(":")}` : ""}}`,
        },
        evidence: [
          {
            ...(routeEvidence[routeEvidence.length - 1] as ScaffoldEvidence),
            construct: "route_template",
          },
        ],
      });
    }
  }
  const response = responseFor(action);
  return {
    ...base,
    method: verb,
    path: lowered.path,
    parameters,
    ...(bound.body ? { requestBody: bound.body } : {}),
    ...(response ? { response } : {}),
    evidence: routeEvidence,
  };
}

function bindingName(parameter: CSharpParameter): string {
  for (const attribute of parameter.attributes) {
    if (/^From(?:Route|Query|Header|Body|Form|Uri)$/.test(attribute.name)) {
      const name = attribute.named.get("Name");
      if (name?.kind === "string" && name.value.length > 0) return name.value;
    }
  }
  return parameter.name;
}

function classifyParameters(
  action: Action,
  tokens: readonly RouteToken[],
  routeEvidence: ScaffoldEvidence[],
): { parameters: ScaffoldParameter[]; body?: ScaffoldPayload } {
  const { decl, method, ctx, framework } = action;
  const apiController = has(decl.attributes, "ApiController");
  const parameters: ScaffoldParameter[] = [];
  const form: {
    name: string;
    schema: ScaffoldSchema;
    required: boolean;
    evidence: ScaffoldEvidence;
  }[] = [];
  let body: ScaffoldPayload | undefined;
  const consumes = stringArgs(method.attributes, "Consumes");
  const controllerConsumes = stringArgs(decl.attributes, "Consumes");
  const contentTypes = consumes.length > 0 ? consumes : controllerConsumes;
  const tokenNames = new Set(tokens.map((token) => token.name.toLowerCase()));

  for (const parameter of method.parameters) {
    const parsed = parseCSharpType(parameter.type);
    if (INFRASTRUCTURE_TYPES.has(parsed.name) || has(parameter.attributes, "FromServices"))
      continue;
    if (has(parameter.attributes, "FromKeyedServices")) continue;
    const name = bindingName(parameter);
    const binding = parameter.attributes.find((a) =>
      /^From(?:Route|Query|Header|Body|Form|Uri)$/.test(a.name),
    );
    const line = (offset: number) => lineAt(decl.file, offset);
    const declared = (construct: string): ScaffoldEvidence => ({
      path: decl.file.path,
      line: line(binding ? binding.offset : parameter.offset),
      construct,
    });
    const schema = schemaForCSharpType(parameter.type, ctx.index);
    const valueRequired =
      has(parameter.attributes, "Required") ||
      has(parameter.attributes, "BindRequired") ||
      (isSimpleType(parameter.type, ctx.index) &&
        !parsed.nullable &&
        !parameter.hasDefault &&
        !/^(?:string|String)$/.test(parsed.name));

    let source: "path" | "query" | "header" | "body" | "form" | undefined;
    let construct: string;
    if (binding) {
      construct = `[${binding.name}]`;
      switch (binding.name) {
        case "FromRoute":
          source = "path";
          break;
        case "FromQuery":
          source = "query";
          break;
        case "FromHeader":
          source = "header";
          break;
        case "FromBody":
          source = "body";
          break;
        case "FromForm":
          source = "form";
          break;
        default:
          source = tokenNames.has(name.toLowerCase()) ? "path" : "query";
          break;
      }
    } else if (FORM_FILE_TYPES.has(parsed.name)) {
      source = "form";
      construct = "inferred_binding";
    } else if (isSimpleType(parameter.type, ctx.index)) {
      source = tokenNames.has(name.toLowerCase()) ? "path" : "query";
      construct = "inferred_binding";
    } else if (isSimpleCollection(parameter.type, ctx.index)) {
      source = "query";
      construct = "inferred_binding";
    } else if (apiController) {
      source = "body";
      construct = "inferred_binding";
    } else {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${framework}/binding_source_undeclared`,
        message: `${decl.name}.${method.name}: parameter '${parameter.name}' (${parameter.type}) declares no binding source and the controller is not an [ApiController]; it was not recorded.`,
        evidence: { path: decl.file.path, line: line(parameter.offset), construct: "parameter" },
      });
      continue;
    }

    if (source === "body") {
      const allowEmpty = binding?.named.get("EmptyBodyBehavior")?.value.endsWith("Allow") ?? false;
      const payload: ScaffoldPayload = {
        contentTypes: [...contentTypes],
        schema,
        required: !allowEmpty && !parsed.nullable,
        evidence: [declared(construct)],
      };
      if (body) {
        ctx.diagnostics.push({
          level: "error",
          code: `legacy/scaffold/${framework}/multiple_body_parameters`,
          message: `${decl.name}.${method.name} binds more than one parameter from the body; only '${body.schema.sourceType ?? "the first"}' was kept.`,
          evidence: declared(construct),
        });
        continue;
      }
      body = payload;
      continue;
    }
    if (source === "form") {
      form.push({
        name,
        schema: FORM_FILE_TYPES.has(parsed.name)
          ? { type: "string", format: "binary", sourceType: parameter.type }
          : schema,
        required: valueRequired,
        evidence: declared(construct),
      });
      continue;
    }
    if (source === "path" && !tokenNames.has(name.toLowerCase())) {
      ctx.diagnostics.push({
        level: "warning",
        code: `legacy/scaffold/${framework}/route_parameter_unbound`,
        message: `${decl.name}.${method.name}: parameter '${name}' binds from the route but no route template declares '{${name}}'.`,
        evidence: declared(construct),
      });
    }
    const token = tokens.find((t) => t.name.toLowerCase() === name.toLowerCase());
    parameters.push({
      name,
      in: source,
      required: source === "path" ? !(token?.optional ?? false) : valueRequired,
      schema,
      evidence: [declared(construct)],
    });
  }

  if (form.length > 0) {
    if (body) {
      ctx.diagnostics.push({
        level: "error",
        code: `legacy/scaffold/${framework}/multiple_body_parameters`,
        message: `${decl.name}.${method.name} binds both a body parameter and form fields; the form fields were dropped.`,
        evidence: form[0]?.evidence ?? (routeEvidence[0] as ScaffoldEvidence),
      });
    } else {
      const properties: Record<string, ScaffoldSchema> = {};
      const required: string[] = [];
      for (const field of form) {
        properties[field.name] = field.schema;
        if (field.required) required.push(field.name);
      }
      body = {
        contentTypes: contentTypes.length > 0 ? [...contentTypes] : ["multipart/form-data"],
        schema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
        required: true,
        evidence: form.map((field) => field.evidence),
      };
    }
  }
  return { parameters, ...(body ? { body } : {}) };
}

function responseFor(action: Action): ScaffoldPayload | undefined {
  const { decl, method, ctx } = action;
  const produces = stringArgs(method.attributes, "Produces");
  const contentTypes = produces.length > 0 ? produces : stringArgs(decl.attributes, "Produces");
  const declared = declaredReturnType(method.returnType);
  if (declared !== undefined) {
    return {
      contentTypes,
      schema: schemaForCSharpType(declared, ctx.index),
      required: false,
      evidence: [evidence(decl.file, method.offset, "return_type")],
    };
  }
  for (const attribute of [
    ...all(method.attributes, "ProducesResponseType"),
    ...all(method.attributes, "Produces"),
  ]) {
    const typeArg =
      attribute.positional.find((argument) => argument.kind === "typeof") ??
      (attribute.named.get("Type")?.kind === "typeof" ? attribute.named.get("Type") : undefined);
    const status = attribute.positional.find((argument) => argument.kind === "other")?.value;
    const ok =
      attribute.name === "Produces" ||
      status === undefined ||
      /(?:^|\D)20[0-9]$|Status20\d/.test(status);
    if (typeArg && ok) {
      return {
        contentTypes,
        schema: schemaForCSharpType(typeArg.value, ctx.index),
        required: false,
        evidence: [evidence(decl.file, attribute.offset, `[${attribute.name}]`)],
      };
    }
  }
  return undefined;
}

function has(attributes: readonly CSharpAttribute[], name: string): boolean {
  return attributes.some((attribute) => attribute.name === name);
}

function all(attributes: readonly CSharpAttribute[], name: string): CSharpAttribute[] {
  return attributes.filter((attribute) => attribute.name === name);
}

function stringArgs(attributes: readonly CSharpAttribute[], name: string): string[] {
  return all(attributes, name).flatMap((attribute) =>
    attribute.positional
      .filter((argument) => argument.kind === "string")
      .map((argument) => argument.value),
  );
}

function evidence(file: CSharpText, offset: number, construct: string): ScaffoldEvidence {
  return { path: file.path, line: lineAt(file, offset), construct };
}
