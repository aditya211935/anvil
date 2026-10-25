/**
 * ASP.NET route templates, Web API convention templates and ASMX activation
 * directives, read as text. A template is lowered to an OpenAPI path exactly
 * as the framework would route it: `[controller]` is the class name without
 * its suffix, `{id:int}` is `{id}` with the constraint's type, `{*path}` is
 * `{path}`. Nothing is added that the template did not state.
 */

import { type CSharpText, matchBracket, splitTopLevel } from "./csharp-text.js";
import type { ScaffoldSchema } from "./model.js";

export interface RouteToken {
  name: string;
  constraints: string[];
  optional: boolean;
  catchAll: boolean;
}

export interface LoweredRoute {
  /** OpenAPI path template: leading slash, `{name}` tokens only. */
  path: string;
  tokens: RouteToken[];
  /** Why the template could not be lowered; the endpoint must not be emitted. */
  invalid?: string;
}

export interface ConventionRouteTemplate {
  template: string;
  /** Tokens given `RouteParameter.Optional` in the defaults. */
  optional: Set<string>;
  file: CSharpText;
  offset: number;
}

const TOKEN = /\{([^{}]*)\}/g;
const ROUTE_PREFIX_SEPARATOR = /\/{2,}/g;

/**
 * Combine a controller-level template with an action-level one. A template
 * beginning with `/` or `~/` replaces the prefix; an absent action template
 * keeps the prefix; neither yields no attribute route at all.
 */
export function combineRouteTemplates(
  prefix: string | undefined,
  template: string | undefined,
): string | undefined {
  if (template !== undefined && (template.startsWith("/") || template.startsWith("~/"))) {
    return template.replace(/^~/, "");
  }
  if (prefix === undefined) return template;
  if (template === undefined || template.length === 0) return prefix;
  return `${prefix.replace(/\/+$/, "")}/${template.replace(/^\/+/, "")}`;
}

/** Replace `[controller]`, `[action]` and `[area]`; returns any token left unresolved. */
export function expandRouteTokens(
  template: string,
  values: { controller: string; action: string; area?: string },
): { template: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const expanded = template.replace(/\[([A-Za-z]+)\]/g, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key === "controller") return values.controller;
    if (key === "action") return values.action;
    if (key === "area" && values.area !== undefined) return values.area;
    unresolved.push(whole);
    return whole;
  });
  return { template: expanded, unresolved };
}

/** Lower a route template to an OpenAPI path with its parameter tokens. */
export function lowerRouteTemplate(template: string): LoweredRoute {
  const trimmed = template.trim().replace(/^~/, "");
  if (/[?#]/.test(trimmed.replace(TOKEN, ""))) {
    return { path: "", tokens: [], invalid: "a route template cannot carry a query string" };
  }
  const tokens: RouteToken[] = [];
  let invalid: string | undefined;
  const lowered = trimmed.replace(TOKEN, (_whole, inner: string) => {
    let body = inner.trim();
    let catchAll = false;
    if (body.startsWith("*")) {
      catchAll = true;
      body = body.replace(/^\*+/, "");
    }
    const equals = body.indexOf("=");
    let optional = false;
    if (equals !== -1) {
      body = body.slice(0, equals);
      optional = true;
    }
    if (body.endsWith("?")) {
      optional = true;
      body = body.slice(0, -1);
    }
    const [name, ...constraints] = body.split(":").map((part) => part.trim());
    if (!name || !/^[A-Za-z_]\w*$/.test(name)) {
      invalid = `route parameter '{${inner}}' has no valid name`;
      return "";
    }
    if (tokens.some((token) => token.name === name)) {
      invalid = `route parameter '{${name}}' is declared twice`;
    }
    tokens.push({ name, constraints: constraints.filter((c) => c.length > 0), optional, catchAll });
    return `{${name}}`;
  });
  if (/[{}]/.test(lowered.replace(/\{[A-Za-z_]\w*\}/g, ""))) {
    invalid = invalid ?? "unbalanced braces in route template";
  }
  let path = `/${lowered}`.replace(ROUTE_PREFIX_SEPARATOR, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return { path, tokens, ...(invalid ? { invalid } : {}) };
}

/** The JSON type a route constraint declares, when it declares one. */
export function schemaForConstraints(constraints: readonly string[]): ScaffoldSchema | undefined {
  for (const constraint of constraints) {
    const name = constraint.replace(/\(.*$/, "").toLowerCase();
    switch (name) {
      case "int":
        return { type: "integer", format: "int32" };
      case "long":
        return { type: "integer", format: "int64" };
      case "bool":
        return { type: "boolean" };
      case "guid":
        return { type: "string", format: "uuid" };
      case "datetime":
        return { type: "string", format: "date-time" };
      case "double":
      case "float":
      case "decimal":
        return { type: "number" };
      case "alpha":
      case "minlength":
      case "maxlength":
      case "length":
      case "regex":
        return { type: "string" };
      default:
        break;
    }
  }
  return undefined;
}

/**
 * `routes.MapHttpRoute(name, routeTemplate, defaults, …)` calls in a Web API
 * configuration file. Only a template given as a string literal counts; a
 * template computed at run time cannot be read from source.
 */
export function findConventionRouteTemplates(file: CSharpText): ConventionRouteTemplate[] {
  const templates: ConventionRouteTemplate[] = [];
  const pattern = /\bMapHttpRoute\s*\(/g;
  for (const match of file.masked.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = matchBracket(file.masked, open, file.masked.length);
    if (close >= file.masked.length) continue;
    const args = splitTopLevel(file.masked, open + 1, close);
    let templateArg: { start: number; end: number } | undefined;
    let defaultsArg: { start: number; end: number } | undefined;
    const positional: { start: number; end: number }[] = [];
    for (const arg of args) {
      const text = file.masked.slice(arg.start, arg.end);
      const named = /^\s*([A-Za-z_]\w*)\s*:/.exec(text);
      if (named) {
        const value = { start: arg.start + named[0].length, end: arg.end };
        if (named[1] === "routeTemplate") templateArg = value;
        if (named[1] === "defaults") defaultsArg = value;
      } else {
        positional.push(arg);
      }
    }
    templateArg = templateArg ?? positional[1];
    defaultsArg = defaultsArg ?? positional[2];
    if (!templateArg) continue;
    const quote = file.masked.indexOf('"', templateArg.start);
    if (quote === -1 || quote >= templateArg.end) continue;
    const template = file.literals.get(quote);
    if (template === undefined) continue;
    const optional = new Set<string>();
    if (defaultsArg) {
      const defaults = file.masked.slice(defaultsArg.start, defaultsArg.end);
      for (const item of defaults.matchAll(
        /([A-Za-z_]\w*)\s*=\s*RouteParameter\s*\.\s*Optional/g,
      )) {
        optional.add(item[1] as string);
      }
    }
    templates.push({ template, optional, file, offset: match.index });
  }
  return templates;
}

export interface AsmxDirective {
  path: string;
  /** The `Class=` value, verbatim (`Legacy.Orders.OrderService`). */
  className: string;
  line: number;
}

const MAX_DIRECTIVE_BYTES = 64 * 1024;

/** Read `<%@ WebService … Class="…" %>` from an .asmx activation file. */
export function parseAsmxDirective(
  path: string,
  text: string,
): { directive?: AsmxDirective; reason?: string } {
  if (text.length > MAX_DIRECTIVE_BYTES) {
    return { reason: `.asmx directive inspection is bounded to ${MAX_DIRECTIVE_BYTES} bytes` };
  }
  const directive = /<%@\s*WebService\b([\s\S]*?)%>/i.exec(text);
  if (!directive) return { reason: "no WebService directive" };
  const attributes = new Map<string, string>();
  for (const match of (directive[1] ?? "").matchAll(
    /\b([A-Za-z_][\w.-]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  )) {
    attributes.set((match[1] as string).toLowerCase(), (match[2] as string).slice(1, -1));
  }
  const className = attributes.get("class")?.trim();
  if (!className || !/^[A-Za-z_][\w.]*(?:\s*,\s*[\w.\s]+)?$/.test(className)) {
    return { reason: "the WebService directive declares no Class" };
  }
  const line = text.slice(0, directive.index).split("\n").length;
  return { directive: { path, className: className.split(",")[0]?.trim() ?? className, line } };
}
