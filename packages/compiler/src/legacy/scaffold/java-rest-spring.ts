import { argumentValue, booleanArgument } from "./java-rest-annotations.js";
import {
  annotationFrom,
  type BasePath,
  diagnostic,
  evidenceAt,
  evidenceOf,
  joinPaths,
  mediaTypesOf,
  readPathStrings,
} from "./java-rest-common.js";
import type { JavaAnnotationUse, JavaMethod, JavaTypeDeclaration } from "./java-rest-source.js";
import {
  isMapLikeType,
  isOptionalType,
  schemaForJavaType,
  type TypeContext,
} from "./java-rest-types.js";
import type {
  ScaffoldDiagnostic,
  ScaffoldEndpoint,
  ScaffoldEvidence,
  ScaffoldHttpMethod,
  ScaffoldParameter,
  ScaffoldPayload,
} from "./model.js";

/**
 * Lower Spring MVC controllers onto scaffold endpoints. A controller is a
 * type annotated `@RestController` or `@Controller`; each handler method's
 * mapping annotation supplies the methods and paths, composed with the
 * class-level `@RequestMapping`. A `@RequestMapping` that declares no HTTP
 * method (and inherits none) is recorded as an unmapped path, one per
 * declared path, never guessed into an operation.
 */

const SPRING_PACKAGES = [
  "org.springframework.web.bind.annotation",
  "org.springframework.stereotype",
];

const MAPPINGS: Readonly<Record<string, ScaffoldHttpMethod | undefined>> = {
  GetMapping: "get",
  PostMapping: "post",
  PutMapping: "put",
  DeleteMapping: "delete",
  PatchMapping: "patch",
  RequestMapping: undefined,
};

const REQUEST_METHODS: Readonly<Record<string, ScaffoldHttpMethod>> = {
  GET: "get",
  POST: "post",
  PUT: "put",
  DELETE: "delete",
  PATCH: "patch",
  HEAD: "head",
  OPTIONS: "options",
};

const PARAMETER_KINDS: Readonly<Record<string, ScaffoldParameter["in"]>> = {
  PathVariable: "path",
  RequestParam: "query",
  RequestHeader: "header",
  CookieValue: "cookie",
};

interface Mapping {
  annotation: JavaAnnotationUse;
  paths: string[];
  methods: ScaffoldHttpMethod[];
  consumes?: string[];
  produces?: string[];
}

function spring(
  annotations: readonly JavaAnnotationUse[],
  names: readonly string[],
): JavaAnnotationUse | undefined {
  return annotationFrom(annotations, names, SPRING_PACKAGES);
}

export function isSpringController(type: JavaTypeDeclaration): boolean {
  return spring(type.annotations, ["RestController", "Controller"]) !== undefined;
}

export function lowerSpringType(
  type: JavaTypeDeclaration,
  base: BasePath,
  context: TypeContext,
  diagnostics: ScaffoldDiagnostic[],
): ScaffoldEndpoint[] {
  const classAnnotation = spring(type.annotations, ["RequestMapping"]);
  let classMapping: Mapping | undefined;
  if (classAnnotation) {
    classMapping = readMapping(classAnnotation, type.path, diagnostics);
    if (!classMapping) return [];
  }
  const endpoints: ScaffoldEndpoint[] = [];
  for (const method of type.methods) {
    const annotation = spring(method.annotations, Object.keys(MAPPINGS));
    if (!annotation) continue;
    const mapping = readMapping(annotation, type.path, diagnostics);
    if (!mapping) continue;
    const methods = mapping.methods.length > 0 ? mapping.methods : (classMapping?.methods ?? []);
    const consumes = mapping.consumes ?? classMapping?.consumes ?? [];
    const produces = mapping.produces ?? classMapping?.produces ?? [];
    const classPaths = classMapping && classMapping.paths.length > 0 ? classMapping.paths : [""];
    const methodPaths = mapping.paths.length > 0 ? mapping.paths : [""];
    const bound = bindParameters(type, method, consumes, mapping.annotation, context, diagnostics);
    const evidence: ScaffoldEvidence[] = [evidenceOf(type.path, annotation)];
    if (classAnnotation) evidence.push(evidenceOf(type.path, classAnnotation));
    if (base.evidence) evidence.push(base.evidence);
    const responseSchema = schemaForJavaType(method.returnType, context);

    for (const classPath of classPaths) {
      for (const methodPath of methodPaths) {
        const path = joinPaths(base.path, classPath, methodPath);
        const variants: (ScaffoldHttpMethod | undefined)[] =
          methods.length > 0 ? methods : [undefined];
        for (const httpMethod of variants) {
          const endpoint: ScaffoldEndpoint = {
            framework: "spring_mvc",
            path,
            operationId: `${type.name}.${method.name}`,
            handler: { type: type.name, member: method.name },
            parameters: bound.parameters,
            evidence,
          };
          if (httpMethod) endpoint.method = httpMethod;
          if (bound.requestBody) endpoint.requestBody = bound.requestBody;
          if (responseSchema) {
            endpoint.response = {
              contentTypes: produces,
              schema: responseSchema,
              required: false,
              evidence: [
                evidenceAt(type.path, method.line, "return"),
                evidenceOf(type.path, annotation),
              ],
            };
          }
          endpoints.push(endpoint);
        }
      }
    }
  }
  return endpoints;
}

function readMapping(
  annotation: JavaAnnotationUse,
  path: string,
  diagnostics: ScaffoldDiagnostic[],
): Mapping | undefined {
  const paths = readPathStrings(annotation, ["value", "path"], "spring_mvc", path, diagnostics);
  if (!paths) return undefined;
  const evidence = evidenceOf(path, annotation);
  const shorthand = MAPPINGS[annotation.simpleName];
  const methods: ScaffoldHttpMethod[] = [];
  if (shorthand) methods.push(shorthand);
  else {
    const declared = annotation.args.named.get("method");
    for (const identifier of declared?.identifiers ?? []) {
      const name = identifier.split(".").at(-1) ?? identifier;
      const mapped = REQUEST_METHODS[name];
      if (mapped) {
        if (!methods.includes(mapped)) methods.push(mapped);
      } else {
        diagnostics.push(
          diagnostic(
            "warning",
            "spring_mvc",
            "unsupported_request_method",
            `RequestMethod '${identifier}' has no OpenAPI operation; it was omitted.`,
            evidence,
          ),
        );
      }
    }
    if (declared?.unsupported) {
      diagnostics.push(
        diagnostic(
          "warning",
          "spring_mvc",
          "unparseable_annotation_arguments",
          "The `method` element used an expression this reader does not evaluate; its methods were omitted.",
          evidence,
        ),
      );
    }
  }
  const mapping: Mapping = { annotation, paths, methods };
  const consumes = annotation.args.named.get("consumes");
  const produces = annotation.args.named.get("produces");
  if (consumes) mapping.consumes = mediaTypesOf(consumes, "spring_mvc", evidence, diagnostics);
  if (produces) mapping.produces = mediaTypesOf(produces, "spring_mvc", evidence, diagnostics);
  return mapping;
}

interface BoundParameters {
  parameters: ScaffoldParameter[];
  requestBody?: ScaffoldPayload;
}

function bindParameters(
  type: JavaTypeDeclaration,
  method: JavaMethod,
  consumes: string[],
  mapping: JavaAnnotationUse,
  context: TypeContext,
  diagnostics: ScaffoldDiagnostic[],
): BoundParameters {
  const parameters: ScaffoldParameter[] = [];
  let requestBody: ScaffoldPayload | undefined;
  for (const parameter of method.parameters) {
    const bound = spring(parameter.annotations, Object.keys(PARAMETER_KINDS));
    const body = spring(parameter.annotations, ["RequestBody"]);
    const annotation = bound ?? body;
    if (!annotation) continue; // Spring's un-annotated binding is a convention, not a declaration.
    if (annotation.unparseable || annotation.args.malformed) {
      diagnostics.push(
        diagnostic(
          "warning",
          "spring_mvc",
          "unparseable_annotation_arguments",
          `@${annotation.simpleName} on ${type.name}.${method.name}(${parameter.name}) could not be read; the parameter was skipped.`,
          evidenceOf(type.path, annotation),
        ),
      );
      continue;
    }
    const schema = schemaForJavaType(parameter.type, context) ?? {
      type: "string",
      sourceType: parameter.type,
    };
    if (body) {
      if (requestBody) {
        diagnostics.push(
          diagnostic(
            "warning",
            "spring_mvc",
            "multiple_request_bodies",
            `${type.name}.${method.name} declares more than one @RequestBody; only the first is read.`,
            evidenceOf(type.path, body),
          ),
        );
        continue;
      }
      requestBody = {
        contentTypes: consumes,
        schema,
        required: booleanArgument(body.args, "required") ?? true,
        evidence: [evidenceOf(type.path, body), evidenceOf(type.path, mapping)],
      };
      continue;
    }
    if (!bound) continue;
    const explicit = argumentValue(bound.args, ["value", "name"]);
    if (explicit && (explicit.unsupported || explicit.strings.length !== 1)) {
      diagnostics.push(
        diagnostic(
          "warning",
          "spring_mvc",
          "unresolvable_parameter_name",
          `@${bound.simpleName} on ${type.name}.${method.name}(${parameter.name}) names its parameter with an expression this reader does not resolve; it was skipped.`,
          evidenceOf(type.path, bound),
        ),
      );
      continue;
    }
    const name = explicit?.strings[0] ?? parameter.name;
    // Without a name, a Map-typed @RequestParam/@RequestHeader binds every
    // value at once; that is not one parameter and is not recorded as one.
    if (!explicit && (isMapLikeType(parameter.type) || /\bHttpHeaders$/u.test(parameter.type))) {
      continue;
    }
    const location = PARAMETER_KINDS[bound.simpleName] as ScaffoldParameter["in"];
    if (parameters.some((existing) => existing.in === location && existing.name === name)) continue;
    const required =
      location === "path"
        ? true
        : (booleanArgument(bound.args, "required") ?? true) &&
          !bound.args.named.has("defaultValue") &&
          !isOptionalType(parameter.type);
    parameters.push({
      name,
      in: location,
      required,
      schema,
      evidence: [evidenceOf(type.path, bound)],
    });
  }
  return requestBody ? { parameters, requestBody } : { parameters };
}
