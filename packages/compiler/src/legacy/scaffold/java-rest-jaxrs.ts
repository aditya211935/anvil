import {
  annotationFrom,
  type BasePath,
  diagnostic,
  evidenceAt,
  evidenceOf,
  joinPaths,
  mediaTypesOf,
  normalizePathTemplate,
  readPathStrings,
} from "./java-rest-common.js";
import type {
  JavaAnnotationUse,
  JavaField,
  JavaMethod,
  JavaParameter,
  JavaTypeDeclaration,
} from "./java-rest-source.js";
import { schemaForJavaType, type TypeContext } from "./java-rest-types.js";
import type {
  ScaffoldDiagnostic,
  ScaffoldEndpoint,
  ScaffoldEvidence,
  ScaffoldHttpMethod,
  ScaffoldParameter,
  ScaffoldPayload,
  ScaffoldSchema,
} from "./model.js";

/**
 * Lower JAX-RS resource classes onto scaffold endpoints. A root resource is a
 * type with a class-level `@Path`; each method carrying one of the standard
 * HTTP method annotations becomes one endpoint at the base, class and method
 * paths joined. Sub-resource locators and non-root resources are reported,
 * never guessed into routes.
 */

const JAXRS_PACKAGES = ["javax.ws.rs", "jakarta.ws.rs", "javax.ws.rs.core", "jakarta.ws.rs.core"];

const HTTP_METHODS: Readonly<Record<string, ScaffoldHttpMethod>> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  DELETE: "delete",
  HEAD: "head",
  OPTIONS: "options",
  PATCH: "patch",
};

const PARAMETER_KINDS: Readonly<Record<string, ScaffoldParameter["in"]>> = {
  PathParam: "path",
  QueryParam: "query",
  HeaderParam: "header",
  CookieParam: "cookie",
};

const CONTEXT_ANNOTATIONS = ["Context", "Suspended"];

interface MediaDeclaration {
  types: string[];
  evidence: ScaffoldEvidence;
}

function jaxrs(
  annotations: readonly JavaAnnotationUse[],
  names: readonly string[],
): JavaAnnotationUse | undefined {
  return annotationFrom(annotations, names, JAXRS_PACKAGES);
}

function httpMethodOf(method: JavaMethod): JavaAnnotationUse | undefined {
  return jaxrs(method.annotations, Object.keys(HTTP_METHODS));
}

export function isJaxrsResource(type: JavaTypeDeclaration): boolean {
  return (
    jaxrs(type.annotations, ["Path"]) !== undefined ||
    type.methods.some((method) => httpMethodOf(method) !== undefined)
  );
}

/** A `javax.ws.rs.core.Application` (or Jersey `ResourceConfig`) subclass. */
export function isJaxrsApplication(type: JavaTypeDeclaration): boolean {
  return type.extendsNames.some((name) => {
    const simple = name.split(".").at(-1);
    return simple === "Application" || simple === "ResourceConfig";
  });
}

export function applicationPathOf(
  type: JavaTypeDeclaration,
  diagnostics: ScaffoldDiagnostic[],
): BasePath | undefined {
  const annotation = jaxrs(type.annotations, ["ApplicationPath"]);
  if (!annotation) return undefined;
  const paths = readPathStrings(annotation, ["value"], "jaxrs", type.path, diagnostics);
  const path = paths?.[0];
  if (path === undefined) return undefined;
  const normalized = normalizePathTemplate(path);
  return {
    path: normalized === "/" ? "" : normalized,
    evidence: evidenceOf(type.path, annotation),
  };
}

export function lowerJaxrsType(
  type: JavaTypeDeclaration,
  base: BasePath,
  context: TypeContext,
  diagnostics: ScaffoldDiagnostic[],
): ScaffoldEndpoint[] {
  const classPathAnnotation = jaxrs(type.annotations, ["Path"]);
  if (!classPathAnnotation) {
    diagnostics.push(
      diagnostic(
        "info",
        "jaxrs",
        "subresource_without_root_path",
        `${type.name} declares HTTP methods but no class-level @Path; it is reached through a locator this reader does not follow.`,
        evidenceAt(type.path, type.line, type.kind),
      ),
    );
    return [];
  }
  const classPaths = readPathStrings(
    classPathAnnotation,
    ["value"],
    "jaxrs",
    type.path,
    diagnostics,
  );
  if (!classPaths) return [];
  const classPath = classPaths[0] ?? "";
  const classConsumes = mediaOf(type.annotations, "Consumes", type.path, diagnostics);
  const classProduces = mediaOf(type.annotations, "Produces", type.path, diagnostics);
  const endpoints: ScaffoldEndpoint[] = [];

  for (const method of type.methods) {
    const http = httpMethodOf(method);
    const methodPathAnnotation = jaxrs(method.annotations, ["Path"]);
    if (!http) {
      if (methodPathAnnotation) {
        diagnostics.push(
          diagnostic(
            "info",
            "jaxrs",
            "subresource_locator_skipped",
            `${type.name}.${method.name} is a sub-resource locator; routes it returns are not read.`,
            evidenceOf(type.path, methodPathAnnotation),
          ),
        );
      }
      continue;
    }
    let methodPath = "";
    if (methodPathAnnotation) {
      const paths = readPathStrings(
        methodPathAnnotation,
        ["value"],
        "jaxrs",
        type.path,
        diagnostics,
      );
      if (!paths) continue;
      methodPath = paths[0] ?? "";
    }
    const consumes =
      mediaOf(method.annotations, "Consumes", type.path, diagnostics) ?? classConsumes;
    const produces =
      mediaOf(method.annotations, "Produces", type.path, diagnostics) ?? classProduces;
    const bound = bindParameters(type, method, consumes, context, diagnostics);
    const evidence: ScaffoldEvidence[] = [
      evidenceOf(type.path, http),
      evidenceOf(type.path, classPathAnnotation),
    ];
    if (methodPathAnnotation) evidence.push(evidenceOf(type.path, methodPathAnnotation));
    if (base.evidence) evidence.push(base.evidence);
    const responseSchema = schemaForJavaType(method.returnType, context);
    const endpoint: ScaffoldEndpoint = {
      framework: "jaxrs",
      method: HTTP_METHODS[http.simpleName] as ScaffoldHttpMethod,
      path: joinPaths(base.path, classPath, methodPath),
      operationId: `${type.name}.${method.name}`,
      handler: { type: type.name, member: method.name },
      parameters: bound.parameters,
      evidence,
    };
    if (bound.requestBody) endpoint.requestBody = bound.requestBody;
    if (responseSchema) {
      const responseEvidence = [evidenceAt(type.path, method.line, "return")];
      if (produces) responseEvidence.push(produces.evidence);
      endpoint.response = {
        contentTypes: produces?.types ?? [],
        schema: responseSchema,
        required: false,
        evidence: responseEvidence,
      };
    }
    endpoints.push(endpoint);
  }
  return endpoints;
}

function mediaOf(
  annotations: readonly JavaAnnotationUse[],
  name: "Consumes" | "Produces",
  path: string,
  diagnostics: ScaffoldDiagnostic[],
): MediaDeclaration | undefined {
  const annotation = jaxrs(annotations, [name]);
  if (!annotation) return undefined;
  const evidence = evidenceOf(path, annotation);
  return {
    types: mediaTypesOf(annotation.args.positional, "jaxrs", evidence, diagnostics),
    evidence,
  };
}

interface BoundParameters {
  parameters: ScaffoldParameter[];
  requestBody?: ScaffoldPayload;
}

function bindParameters(
  type: JavaTypeDeclaration,
  method: JavaMethod,
  consumes: MediaDeclaration | undefined,
  context: TypeContext,
  diagnostics: ScaffoldDiagnostic[],
): BoundParameters {
  const parameters: ScaffoldParameter[] = [];
  const formFields: Record<string, ScaffoldSchema> = {};
  const formEvidence: ScaffoldEvidence[] = [];
  let entity: ScaffoldPayload | undefined;

  const bindOne = (parameter: JavaParameter | JavaField, allowEntity: boolean): void => {
    if (jaxrs(parameter.annotations, CONTEXT_ANNOTATIONS)) return;
    const bound = jaxrs(parameter.annotations, Object.keys(PARAMETER_KINDS));
    const form = jaxrs(parameter.annotations, ["FormParam"]);
    const matrix = jaxrs(parameter.annotations, ["MatrixParam"]);
    const bean = jaxrs(parameter.annotations, ["BeanParam"]);
    const annotation = bound ?? form ?? matrix ?? bean;
    if (annotation && (annotation.unparseable || annotation.args.malformed)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "jaxrs",
          "unparseable_annotation_arguments",
          `@${annotation.simpleName} on ${type.name}.${method.name}(${parameter.name}) could not be read; the parameter was skipped.`,
          evidenceOf(type.path, annotation),
        ),
      );
      return;
    }
    if (matrix) {
      diagnostics.push(
        diagnostic(
          "info",
          "jaxrs",
          "matrix_param_unrepresentable",
          `@MatrixParam on ${type.name}.${method.name}(${parameter.name}) has no OpenAPI location; it was skipped.`,
          evidenceOf(type.path, matrix),
        ),
      );
      return;
    }
    if (bean) {
      const shape = context.shapes.get(parameter.type.split(".").at(-1) ?? parameter.type);
      if (!shape) {
        diagnostics.push(
          diagnostic(
            "info",
            "jaxrs",
            "bean_param_unexpanded",
            `@BeanParam ${parameter.type} on ${type.name}.${method.name} is not declared in this source set; its fields were not read.`,
            evidenceOf(type.path, bean),
          ),
        );
        return;
      }
      for (const field of shape.fields) if (!field.isStatic) bindOne(field, false);
      return;
    }
    const schema = schemaForJavaType(parameter.type, context) ?? {
      type: "string",
      sourceType: parameter.type,
    };
    if (form) {
      const name = form.args.positional?.strings[0];
      if (!name) return;
      if (!formFields[name]) formFields[name] = schema;
      formEvidence.push(evidenceOf(type.path, form));
      return;
    }
    if (bound) {
      const name = bound.args.positional?.strings[0];
      if (!name) {
        diagnostics.push(
          diagnostic(
            "warning",
            "jaxrs",
            "unresolvable_parameter_name",
            `@${bound.simpleName} on ${type.name}.${method.name}(${parameter.name}) names its parameter with an expression this reader does not resolve; it was skipped.`,
            evidenceOf(type.path, bound),
          ),
        );
        return;
      }
      const location = PARAMETER_KINDS[bound.simpleName] as ScaffoldParameter["in"];
      if (parameters.some((existing) => existing.in === location && existing.name === name)) return;
      parameters.push({
        name,
        in: location,
        required: location === "path",
        schema,
        evidence: [evidenceOf(type.path, bound)],
      });
      return;
    }
    if (!allowEntity) return;
    if (entity) {
      diagnostics.push(
        diagnostic(
          "warning",
          "jaxrs",
          "multiple_entity_parameters",
          `${type.name}.${method.name} declares more than one un-annotated parameter; only the first is read as the request entity.`,
          evidenceAt(type.path, parameter.line, "parameter"),
        ),
      );
      return;
    }
    const evidence = [evidenceAt(type.path, parameter.line, "parameter")];
    if (consumes) evidence.push(consumes.evidence);
    entity = { contentTypes: consumes?.types ?? [], schema, required: true, evidence };
  };

  for (const parameter of method.parameters) bindOne(parameter, true);

  const result: BoundParameters = { parameters };
  if (Object.keys(formFields).length > 0) {
    if (entity) {
      diagnostics.push(
        diagnostic(
          "warning",
          "jaxrs",
          "conflicting_body_declarations",
          `${type.name}.${method.name} declares both @FormParam fields and an entity parameter; the form fields were kept.`,
          evidenceAt(type.path, method.line, "method"),
        ),
      );
    }
    const evidence = [...formEvidence];
    if (consumes) evidence.push(consumes.evidence);
    result.requestBody = {
      contentTypes: consumes?.types.length ? consumes.types : ["application/x-www-form-urlencoded"],
      schema: { type: "object", properties: formFields },
      required: false,
      evidence,
    };
  } else if (entity) {
    result.requestBody = entity;
  }
  return result;
}
