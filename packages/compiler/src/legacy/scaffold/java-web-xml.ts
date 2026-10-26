import { childrenNamed } from "../../protocols/xml.js";
import { childText, elementName, parseSafeDescriptorXml } from "../collectors/java-ee/xml.js";
import {
  type BasePath,
  diagnostic,
  evidenceAt,
  normalizePathTemplate,
} from "./java-rest-common.js";
import type { ScaffoldDiagnostic, ScaffoldEndpoint } from "./model.js";

/**
 * Read `web.xml` servlet mappings as inert data. Every `<url-pattern>` of an
 * ordinary servlet becomes an unmapped endpoint (the descriptor declares a
 * path but no HTTP method). A mapping whose servlet is a JAX-RS container or
 * a Spring `DispatcherServlet` is instead the base path under which that
 * framework's annotated routes are served.
 */

export interface WebXmlReading {
  endpoints: ScaffoldEndpoint[];
  jaxrsBasePaths: BasePath[];
  springBasePaths: BasePath[];
  diagnostics: ScaffoldDiagnostic[];
}

interface ServletDeclaration {
  name: string;
  className?: string;
  initParams: Map<string, string>;
}

const JAXRS_CONTAINERS = new Set([
  "org.glassfish.jersey.servlet.ServletContainer",
  "com.sun.jersey.spi.container.servlet.ServletContainer",
  "org.apache.cxf.jaxrs.servlet.CXFNonSpringJaxrsServlet",
  "org.jboss.resteasy.plugins.server.servlet.HttpServletDispatcher",
  "org.jboss.resteasy.plugins.server.servlet.HttpServlet30Dispatcher",
  "org.apache.wink.server.internal.servlet.RestServlet",
  "javax.ws.rs.core.Application",
  "jakarta.ws.rs.core.Application",
]);

const JAXRS_APPLICATION_PARAMS = new Set([
  "javax.ws.rs.Application",
  "jakarta.ws.rs.Application",
  "javax.ws.rs.core.Application",
  "jakarta.ws.rs.core.Application",
]);

const SPRING_DISPATCHERS = new Set(["org.springframework.web.servlet.DispatcherServlet"]);

export function readWebXml(
  path: string,
  text: string,
  applicationClasses: ReadonlySet<string>,
): WebXmlReading {
  const reading: WebXmlReading = {
    endpoints: [],
    jaxrsBasePaths: [],
    springBasePaths: [],
    diagnostics: [],
  };
  const parsed = parseSafeDescriptorXml(text);
  if (!parsed.ok) {
    reading.diagnostics.push(
      diagnostic(
        "warning",
        "servlet",
        parsed.kind === "unsafe" ? "unsafe_descriptor" : "malformed_descriptor",
        `${path}: ${parsed.message}`,
        { path },
      ),
    );
    return reading;
  }
  if (elementName(parsed.root) !== "web-app") {
    reading.diagnostics.push(
      diagnostic(
        "info",
        "servlet",
        "not_a_web_descriptor",
        `${path} has root <${parsed.root.tag}>, not <web-app>; no servlet mapping was read.`,
        { path },
      ),
    );
    return reading;
  }

  const servlets = new Map<string, ServletDeclaration>();
  for (const servlet of childrenNamed(parsed.root, "servlet")) {
    const name = childText(servlet, "servlet-name");
    if (!name) continue;
    const initParams = new Map<string, string>();
    for (const param of childrenNamed(servlet, "init-param")) {
      const paramName = childText(param, "param-name");
      const paramValue = childText(param, "param-value");
      if (paramName && paramValue) initParams.set(paramName, paramValue);
    }
    const className = childText(servlet, "servlet-class");
    servlets.set(name, { name, ...(className ? { className } : {}), initParams });
  }

  const mappingTags = [...text.matchAll(/<servlet-mapping\b/gu)].map((match) => match.index);
  childrenNamed(parsed.root, "servlet-mapping").forEach((mapping, index) => {
    const servletName = childText(mapping, "servlet-name");
    const patterns = childrenNamed(mapping, "url-pattern")
      .map((element) => element.text.trim())
      .filter((pattern) => pattern !== "");
    if (!servletName || patterns.length === 0) return;
    const lines = patternLines(text, mappingTags[index], patterns.length);
    const servlet = servlets.get(servletName);
    const handlerType = servlet?.className ?? servletName;
    if (!servlet) {
      reading.diagnostics.push(
        diagnostic(
          "warning",
          "servlet",
          "unknown_servlet",
          `servlet-mapping for '${servletName}' names no <servlet> in ${path}; the servlet name stands for its class.`,
          evidenceAt(path, lines[0] ?? 1, "servlet-mapping"),
        ),
      );
    }
    const role = servletRole(servlet, applicationClasses);
    patterns.forEach((pattern, patternIndex) => {
      const evidence = evidenceAt(path, lines[patternIndex] ?? lines[0] ?? 1, "servlet-mapping");
      if (role !== "servlet") {
        const base = prefixOf(pattern);
        if (base === undefined) {
          reading.diagnostics.push(
            diagnostic(
              "info",
              "servlet",
              "extension_mapping_not_prefix",
              `url-pattern '${pattern}' for ${handlerType} is an extension mapping, not a path prefix; it does not place annotated routes.`,
              evidence,
            ),
          );
          return;
        }
        (role === "jaxrs" ? reading.jaxrsBasePaths : reading.springBasePaths).push({
          path: base,
          evidence,
        });
        return;
      }
      reading.endpoints.push({
        framework: "servlet",
        path: pattern.startsWith("*.") ? pattern : normalizePathTemplate(pattern),
        operationId: handlerType.split(".").at(-1) ?? handlerType,
        handler: { type: handlerType, member: "service" },
        parameters: [],
        evidence: [evidence],
      });
    });
  });
  return reading;
}

function servletRole(
  servlet: ServletDeclaration | undefined,
  applicationClasses: ReadonlySet<string>,
): "jaxrs" | "spring" | "servlet" {
  if (!servlet) return "servlet";
  if (servlet.className) {
    if (JAXRS_CONTAINERS.has(servlet.className) || applicationClasses.has(servlet.className)) {
      return "jaxrs";
    }
    if (SPRING_DISPATCHERS.has(servlet.className)) return "spring";
  } else if (applicationClasses.has(servlet.name)) {
    // Servlet 3: a <servlet> named after the Application subclass, no class.
    return "jaxrs";
  }
  for (const name of servlet.initParams.keys()) {
    if (JAXRS_APPLICATION_PARAMS.has(name)) return "jaxrs";
  }
  return "servlet";
}

/** `/api/*` → `/api`; `/*` and `/` → ``; `*.do` → undefined (not a prefix). */
function prefixOf(pattern: string): string | undefined {
  if (pattern.startsWith("*.")) return undefined;
  const trimmed = pattern.endsWith("/*") ? pattern.slice(0, -2) : pattern;
  const normalized = normalizePathTemplate(trimmed === "" ? "/" : trimmed);
  return normalized === "/" ? "" : normalized;
}

/** 1-based lines of the `<url-pattern>` tags that follow one `<servlet-mapping>`. */
function patternLines(text: string, from: number | undefined, count: number): number[] {
  if (from === undefined) return [];
  const lines: number[] = [];
  let cursor = from;
  for (let index = 0; index < count; index += 1) {
    const next = text.indexOf("<url-pattern", cursor);
    if (next < 0) break;
    lines.push(text.slice(0, next).split("\n").length);
    cursor = next + "<url-pattern".length;
  }
  return lines;
}
