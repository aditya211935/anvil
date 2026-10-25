import type { AnnotationValue } from "./java-rest-annotations.js";
import type { JavaAnnotationUse } from "./java-rest-source.js";
import type { ScaffoldDiagnostic, ScaffoldEvidence } from "./model.js";

/** The diagnostic namespaces the Java lane writes under `legacy/scaffold/`. */
export type JavaLaneFramework = "jaxrs" | "spring_mvc" | "servlet" | "java";

export interface BasePath {
  path: string;
  evidence?: ScaffoldEvidence;
}

export function diagnostic(
  level: ScaffoldDiagnostic["level"],
  framework: JavaLaneFramework,
  reason: string,
  message: string,
  evidence?: ScaffoldEvidence,
): ScaffoldDiagnostic {
  return {
    level,
    code: `legacy/scaffold/${framework}/${reason}`,
    message,
    ...(evidence ? { evidence } : {}),
  };
}

export function evidenceAt(path: string, line: number, construct?: string): ScaffoldEvidence {
  return { path, line, ...(construct ? { construct } : {}) };
}

export function evidenceOf(path: string, annotation: JavaAnnotationUse): ScaffoldEvidence {
  return evidenceAt(path, annotation.line, `@${annotation.simpleName}`);
}

/**
 * The first annotation whose simple name is listed and whose written name is
 * either that simple name or fully qualified under one of the given packages.
 * A `com.acme.GET` is never read as JAX-RS.
 */
export function annotationFrom(
  annotations: readonly JavaAnnotationUse[],
  simpleNames: readonly string[],
  packages: readonly string[],
): JavaAnnotationUse | undefined {
  return annotations.find(
    (annotation) =>
      simpleNames.includes(annotation.simpleName) &&
      (annotation.name === annotation.simpleName ||
        packages.some((prefix) => annotation.name === `${prefix}.${annotation.simpleName}`)),
  );
}

/** Join path segments the way a router would: one slash between, no doubles. */
export function joinPaths(...segments: readonly string[]): string {
  return normalizePathTemplate(segments.filter((segment) => segment !== "").join("/"));
}

/**
 * Lower a framework path template onto the OpenAPI template grammar:
 * `{id: [0-9]+}` and `{id:\\d+}` become `{id}`, duplicate slashes collapse,
 * a leading slash is ensured and a trailing one dropped. Wildcards (`*`,
 * `**`) and `${property}` placeholders are kept verbatim; the caller warns
 * about the latter because nothing here can resolve them.
 */
export function normalizePathTemplate(template: string): string {
  let out = "";
  let index = 0;
  while (index < template.length) {
    const char = template[index] ?? "";
    if (char === "{" && template[index - 1] !== "$") {
      const name = /^\{\s*([^{}:\s]+)\s*(:|\})/u.exec(template.slice(index));
      if (name) {
        out += `{${name[1]}}`;
        if (name[2] === ":") {
          let depth = 1;
          let cursor = index + name[0].length;
          while (cursor < template.length && depth > 0) {
            if (template[cursor] === "{") depth += 1;
            else if (template[cursor] === "}") depth -= 1;
            cursor += 1;
          }
          index = cursor;
        } else index += name[0].length;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  out = out.replace(/\/{2,}/gu, "/");
  if (!out.startsWith("/")) out = `/${out}`;
  if (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function hasPropertyPlaceholder(template: string): boolean {
  return /\$\{[^}]*\}/u.test(template);
}

/**
 * Read the path strings of one mapping annotation. Returns `undefined` when
 * the element was written as something other than string literals (a
 * constant, a concatenation), after recording why; an empty array when the
 * annotation declares no path element at all.
 */
export function readPathStrings(
  annotation: JavaAnnotationUse,
  elementNames: readonly string[],
  framework: JavaLaneFramework,
  sourcePath: string,
  diagnostics: ScaffoldDiagnostic[],
): string[] | undefined {
  const evidence = evidenceOf(sourcePath, annotation);
  if (annotation.unparseable || annotation.args.malformed) {
    diagnostics.push(
      diagnostic(
        "warning",
        framework,
        "unparseable_annotation_arguments",
        `@${annotation.simpleName} arguments could not be read as literals; the mapping was skipped.`,
        evidence,
      ),
    );
    return undefined;
  }
  const value = argumentValueOf(annotation, elementNames);
  if (!value) return [];
  if (value.unsupported || value.identifiers.length > 0 || value.strings.length === 0) {
    diagnostics.push(
      diagnostic(
        "warning",
        framework,
        "unresolvable_path_expression",
        `@${annotation.simpleName} path is not a string literal; this reader does not resolve constants, so the mapping was skipped.`,
        evidence,
      ),
    );
    return undefined;
  }
  for (const path of value.strings) {
    if (hasPropertyPlaceholder(path)) {
      diagnostics.push(
        diagnostic(
          "warning",
          framework,
          "unresolved_property_placeholder",
          `Path '${path}' carries a property placeholder that is kept verbatim; resolve it before compiling.`,
          evidence,
        ),
      );
    }
  }
  return value.strings;
}

function argumentValueOf(
  annotation: JavaAnnotationUse,
  names: readonly string[],
): AnnotationValue | undefined {
  for (const name of names) {
    const value = annotation.args.named.get(name);
    if (value) return value;
  }
  return names.includes("value") ? annotation.args.positional : undefined;
}

/**
 * `javax.ws.rs.core.MediaType` and `org.springframework.http.MediaType`
 * constants, by their declared names. These are the specifications' own
 * definitions, not an inference about any application.
 */
const MEDIA_TYPE_CONSTANTS: Readonly<Record<string, string>> = {
  ALL: "*/*",
  WILDCARD: "*/*",
  APPLICATION_ATOM_XML: "application/atom+xml",
  APPLICATION_CBOR: "application/cbor",
  APPLICATION_FORM_URLENCODED: "application/x-www-form-urlencoded",
  APPLICATION_JSON: "application/json",
  APPLICATION_JSON_PATCH_JSON: "application/json-patch+json",
  APPLICATION_NDJSON: "application/x-ndjson",
  APPLICATION_OCTET_STREAM: "application/octet-stream",
  APPLICATION_PDF: "application/pdf",
  APPLICATION_PROBLEM_JSON: "application/problem+json",
  APPLICATION_PROBLEM_XML: "application/problem+xml",
  APPLICATION_RSS_XML: "application/rss+xml",
  APPLICATION_STREAM_JSON: "application/stream+json",
  APPLICATION_SVG_XML: "application/svg+xml",
  APPLICATION_XHTML_XML: "application/xhtml+xml",
  APPLICATION_XML: "application/xml",
  IMAGE_GIF: "image/gif",
  IMAGE_JPEG: "image/jpeg",
  IMAGE_PNG: "image/png",
  MULTIPART_FORM_DATA: "multipart/form-data",
  MULTIPART_MIXED: "multipart/mixed",
  MULTIPART_RELATED: "multipart/related",
  SERVER_SENT_EVENTS: "text/event-stream",
  TEXT_EVENT_STREAM: "text/event-stream",
  TEXT_HTML: "text/html",
  TEXT_MARKDOWN: "text/markdown",
  TEXT_PLAIN: "text/plain",
  TEXT_XML: "text/xml",
};

/**
 * Media types declared on a `@Consumes`/`@Produces` or `consumes`/`produces`
 * element. String literals are taken as written (parameters such as
 * `;charset=UTF-8` dropped, since they are not part of the type); known
 * `MediaType` constants are looked up; anything else is reported and omitted.
 */
export function mediaTypesOf(
  value: AnnotationValue | undefined,
  framework: JavaLaneFramework,
  evidence: ScaffoldEvidence,
  diagnostics: ScaffoldDiagnostic[],
): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const literal of value.strings) {
    const type = (literal.split(";")[0] ?? "").trim().toLowerCase();
    if (type) out.push(type);
  }
  for (const identifier of value.identifiers) {
    const constant = (identifier.split(".").at(-1) ?? "").replace(/_VALUE$/u, "");
    const resolved = MEDIA_TYPE_CONSTANTS[constant];
    if (resolved) out.push(resolved);
    else {
      diagnostics.push(
        diagnostic(
          "warning",
          framework,
          "unresolvable_media_type",
          `Media type '${identifier}' is not a MediaType constant this reader knows; it was omitted.`,
          evidence,
        ),
      );
    }
  }
  if (value.unsupported) {
    diagnostics.push(
      diagnostic(
        "warning",
        framework,
        "unparseable_annotation_arguments",
        "A media type element used an expression this reader does not evaluate; it was omitted.",
        evidence,
      ),
    );
  }
  return [...new Set(out)].sort();
}
