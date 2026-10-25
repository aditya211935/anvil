import { DEFAULT_MAX_MEMBER_BYTES } from "../collectors/java-ee/collector.js";
import { type BasePath, diagnostic, evidenceOf } from "./java-rest-common.js";
import {
  applicationPathOf,
  isJaxrsApplication,
  isJaxrsResource,
  lowerJaxrsType,
} from "./java-rest-jaxrs.js";
import { type JavaSourceFile, readJavaSource } from "./java-rest-source.js";
import { isSpringController, lowerSpringType } from "./java-rest-spring.js";
import { buildTypeContext } from "./java-rest-types.js";
import { readWebXml } from "./java-web-xml.js";
import {
  EMPTY_SCAFFOLD,
  type ScaffoldDiagnostic,
  type ScaffoldEndpoint,
  type ScaffoldResult,
  type ScaffoldSourceMember,
} from "./model.js";

/** The largest `.java` or `web.xml` member the lane reads; larger ones are reported and skipped. */
export const JAVA_SCAFFOLD_MAX_MEMBER_BYTES = DEFAULT_MAX_MEMBER_BYTES;

const WEB_XML = /(?:^|\/)web\.xml$/iu;

/**
 * Recover HTTP endpoints from Java source: JAX-RS (`@Path`, `@GET`, …),
 * Spring MVC (`@RequestMapping`, `@GetMapping`, …) and `web.xml` servlet
 * mappings. Reads source as inert text; never resolves types or runs code.
 *
 * The result is a function of the member set alone: members are sorted by
 * path, endpoints follow source order within each file, and operation ids
 * are made unique by source order, so two readings of the same source agree
 * byte for byte.
 */
export function scaffoldJavaRest(members: readonly ScaffoldSourceMember[]): ScaffoldResult {
  if (members.length === 0) return EMPTY_SCAFFOLD;
  const diagnostics: ScaffoldDiagnostic[] = [];
  const sorted = [...members].sort((left, right) => left.path.localeCompare(right.path));
  const javaFiles: JavaSourceFile[] = [];
  const descriptors: { path: string; text: string }[] = [];
  let inspected = 0;

  for (const member of sorted) {
    if (member.bytes.byteLength > JAVA_SCAFFOLD_MAX_MEMBER_BYTES) {
      diagnostics.push(
        diagnostic(
          "warning",
          "java",
          "member_too_large",
          `${member.path} is ${member.bytes.byteLength} bytes; the limit is ${JAVA_SCAFFOLD_MAX_MEMBER_BYTES}. It was not read.`,
          { path: member.path },
        ),
      );
      continue;
    }
    const text = decodeUtf8(member.bytes);
    if (text === undefined) {
      diagnostics.push(
        diagnostic(
          "warning",
          "java",
          "member_not_utf8",
          `${member.path} is not valid UTF-8 text. It was not read.`,
          { path: member.path },
        ),
      );
      continue;
    }
    inspected += 1;
    if (WEB_XML.test(member.path)) descriptors.push({ path: member.path, text });
    else javaFiles.push(readJavaSource(member.path, text));
  }

  for (const file of javaFiles) {
    for (const annotation of file.annotations) {
      if (!annotation.unparseable) continue;
      diagnostics.push(
        diagnostic(
          "warning",
          "java",
          "unparseable_annotation_arguments",
          `@${annotation.simpleName} opens arguments that never close; everything after it in ${file.path} may have been skipped.`,
          evidenceOf(file.path, annotation),
        ),
      );
    }
  }

  const context = buildTypeContext(javaFiles);
  const applications = javaFiles.flatMap((file) => file.types.filter(isJaxrsApplication));
  const applicationClasses = new Set(
    applications.flatMap((type) => [type.qualifiedName, type.name]),
  );
  const applicationPaths = applications
    .map((type) => applicationPathOf(type, diagnostics))
    .filter((base): base is BasePath => base !== undefined);
  const readings = descriptors.map(({ path, text }) => readWebXml(path, text, applicationClasses));
  for (const reading of readings) diagnostics.push(...reading.diagnostics);

  const jaxrsBase = chooseBase(
    "jaxrs",
    applicationPaths.length > 0
      ? applicationPaths
      : readings.flatMap((reading) => reading.jaxrsBasePaths),
    diagnostics,
  );
  const springBase = chooseBase(
    "spring_mvc",
    readings.flatMap((reading) => reading.springBasePaths),
    diagnostics,
  );

  const endpoints: ScaffoldEndpoint[] = [];
  for (const file of javaFiles) {
    for (const type of file.types) {
      if (isJaxrsResource(type)) {
        endpoints.push(...lowerJaxrsType(type, jaxrsBase, context, diagnostics));
      }
      if (isSpringController(type)) {
        endpoints.push(...lowerSpringType(type, springBase, context, diagnostics));
      }
    }
  }
  for (const reading of readings) endpoints.push(...reading.endpoints);
  assignOperationIds(endpoints, diagnostics);
  return { endpoints, diagnostics, inputMembers: inspected };
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * One declared base path is applied; several distinct ones cannot be assigned
 * to resources without resolving which application each belongs to, so none
 * is applied and the ambiguity is reported.
 */
function chooseBase(
  framework: "jaxrs" | "spring_mvc",
  candidates: readonly BasePath[],
  diagnostics: ScaffoldDiagnostic[],
): BasePath {
  const distinct = [...new Set(candidates.map((candidate) => candidate.path))];
  if (distinct.length === 0) return { path: "" };
  const first = candidates[0] as BasePath;
  if (distinct.length === 1) return first;
  diagnostics.push(
    diagnostic(
      "warning",
      framework,
      "ambiguous_base_path",
      `Several base paths are declared (${distinct.map((path) => `'${path}'`).join(", ")}); none was applied because the source does not say which resources each serves.`,
      first.evidence,
    ),
  );
  return { path: "" };
}

/**
 * `<SimpleClassName>.<methodName>` is the operation id; when the same handler
 * coordinate is produced more than once (an overloaded method, a mapping with
 * several paths or methods, two classes sharing a simple name), the later
 * ones by source order take a `_<n>` suffix and the reader says so.
 */
function assignOperationIds(
  endpoints: ScaffoldEndpoint[],
  diagnostics: ScaffoldDiagnostic[],
): void {
  const counts = new Map<string, number>();
  for (const endpoint of endpoints) {
    const base = endpoint.operationId;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    if (count === 1) continue;
    endpoint.operationId = `${base}_${count}`;
    if (endpoint.method === undefined) continue;
    diagnostics.push(
      diagnostic(
        "info",
        endpoint.framework === "spring_mvc" ? "spring_mvc" : "jaxrs",
        "repeated_handler_id",
        `${base} is produced more than once (an overload or a mapping with several routes); this occurrence is '${endpoint.operationId}'.`,
        endpoint.evidence[0],
      ),
    );
  }
}
