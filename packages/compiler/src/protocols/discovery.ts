/**
 * Google API Discovery Document (`discovery#restDescription`) → OpenAPI 3.0
 * adapter. Every Google Workspace / Cloud API (Gmail, Calendar, Drive, Sheets,
 * BigQuery, …) is published in this format, not OpenAPI — a nested
 * `resources.<r>.methods.<m>` tree with bare `$ref: "TypeName"` schema
 * references, rather than flat `paths` and `#/components/schemas/…` pointers.
 *
 * The lowering is mechanical and faithful: each method becomes one operation
 * (its `path` + `httpMethod`), Discovery `parameters` become OpenAPI
 * parameters (`location` → `in`, `repeated` → array), `request`/`response`
 * `$ref`s become a JSON request body / 200 response, every `schemas` entry
 * becomes a `components.schemas` entry, and every bare `$ref: "Name"` is
 * rewritten to `$ref: "#/components/schemas/Name"` so the shared dereferencer
 * resolves it exactly like any OpenAPI source. Effect/idempotency/naming are
 * then inferred by the same protocol-agnostic pipeline as every other format.
 */
import type { Diagnostic } from "@anvil/air";
import type { OpenApiDocument } from "../parse.js";

interface DiscoveryParam {
  type?: string;
  format?: string;
  description?: string;
  location?: "path" | "query";
  required?: boolean;
  repeated?: boolean;
  default?: unknown;
  enum?: string[];
  $ref?: string;
  /**
   * The anchored regular expression a reserved-expansion resource name must
   * match (`^projects/[^/]+/datasets/[^/]+/tables/[^/]+$`). It is the only
   * place the document states which resource a `{+resource}` method addresses.
   */
  pattern?: string;
}

interface DiscoveryMethod {
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, DiscoveryParam>;
  request?: { $ref?: string };
  response?: { $ref?: string };
  scopes?: string[];
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

interface DiscoveryDoc {
  kind?: string;
  title?: string;
  name?: string;
  version?: string;
  description?: string;
  rootUrl?: string;
  baseUrl?: string;
  servicePath?: string;
  documentationLink?: string;
  resources?: Record<string, DiscoveryResource>;
  methods?: Record<string, DiscoveryMethod>;
  parameters?: Record<string, DiscoveryParam>;
  schemas?: Record<string, unknown>;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
}

/** Recognize a Discovery document by its `kind` discriminator (very reliable). */
export function isDiscoveryDocument(text: string): boolean {
  // Cheap text sniff first so we don't JSON.parse a large non-Discovery file.
  if (!text.includes("discovery#restDescription")) return false;
  try {
    return (JSON.parse(text) as DiscoveryDoc).kind === "discovery#restDescription";
  } catch {
    return false;
  }
}

/** Rewrite every bare Discovery `$ref: "Name"` to an OpenAPI component pointer. */
function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node !== null && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$ref" && typeof v === "string" && !v.startsWith("#/")) {
        out.$ref = `#/components/schemas/${v}`;
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return node;
}

/** One Discovery parameter → one OpenAPI parameter object. */
function toOpenApiParam(name: string, p: DiscoveryParam): Record<string, unknown> {
  const inLoc = p.location === "path" ? "path" : "query";
  const base: Record<string, unknown> = { type: p.type ?? "string" };
  if (p.format) base.format = p.format;
  if (p.enum) base.enum = p.enum;
  if (p.default !== undefined) {
    // Discovery serializes scalar defaults as strings, including booleans and
    // numbers. JSON Schema defaults must retain the declared value's type.
    let value = p.default;
    if (typeof value === "string") {
      if (p.type === "boolean" && /^(true|false)$/.test(value)) value = value === "true";
      else if (
        (p.type === "integer" || p.type === "number") &&
        value.trim() !== "" &&
        Number.isFinite(Number(value))
      )
        value = Number(value);
    }
    base.default = value;
  }
  // Discovery marks a list-valued param with `repeated: true`, not an array type.
  const schema = p.repeated ? { type: "array", items: base } : base;
  return {
    name,
    in: inLoc,
    // Path params are always required; query params honor the declared flag.
    required: inLoc === "path" ? true : Boolean(p.required),
    description: p.description,
    schema,
  };
}

/** Walk the nested resource tree, emitting `[path, method, methodDef]` triples. */
function* eachMethod(
  resources: Record<string, DiscoveryResource> | undefined,
): Generator<DiscoveryMethod> {
  if (!resources) return;
  for (const resource of Object.values(resources)) {
    for (const method of Object.values(resource.methods ?? {})) yield method;
    yield* eachMethod(resource.resources);
  }
}

/** A URI template split into its literal text and `{var}` / `{+var}` tokens. */
interface TemplateToken {
  literal?: string;
  variable?: string;
  reserved?: boolean;
}

function tokenizeTemplate(template: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  const re = /\{(\+?)([^{}]+)\}/g;
  let last = 0;
  for (const m of template.matchAll(re)) {
    const index = m.index ?? 0;
    if (index > last) tokens.push({ literal: template.slice(last, index) });
    tokens.push({ variable: m[2] as string, reserved: m[1] === "+" });
    last = index + m[0].length;
  }
  if (last < template.length) tokens.push({ literal: template.slice(last) });
  return tokens;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SINGLE_VARIABLE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const PATTERN_LITERAL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const PATTERN_VARIABLE_SEGMENT = "[^/]+";
/** Stands in for one `[^/]+` group while a pattern is split into segments. */
const PATTERN_VARIABLE_MARK = "\u0000";

/** The result of re-lowering one method on its `flatPath`. */
interface FlatPathBinding {
  /** The OpenAPI path (leading slash, every `{var}` bound to a parameter below). */
  path: string;
  /**
   * The method's parameters with each expanded resource template replaced, in
   * place, by its segment parameters in URL order — so the position Discovery's
   * `parameterOrder` gave the template (`["resource"]`) now holds its segments
   * (`projectsId, datasetsId, tablesId`), in the order the URL needs them.
   */
  parameters: Record<string, DiscoveryParam>;
  /** Human-readable account of each rebinding (`resource → projectsId, datasetsId, tablesId`). */
  expansions: string[];
}

/**
 * Re-lower one method on its `flatPath`, deriving a real path parameter for
 * every flatPath variable and dropping the reserved-expansion parameter
 * (`resource`, `name`) whose `pattern` spells out exactly that segment
 * structure. Used ONLY when two methods collide on verb + `path`: the
 * OpenAPI path map cannot hold two operations at one verb+path, and the
 * flatPath is where the document says which resource each method addresses.
 *
 * The derivation is verified before it is used, segment by segment: the
 * flatPath must fit the `path` template; each reserved variable's `pattern`
 * must be anchored, have exactly as many `/`-segments as the flatPath text it
 * stands for, and agree with it literal-for-literal, with every `[^/]+` group
 * facing one flatPath variable. Anything the two cannot reconcile is a
 * `reason` string, and the caller keeps refusing the lossy conversion.
 */
function bindFlatPath(
  method: DiscoveryMethod,
  parameters: Record<string, DiscoveryParam>,
): FlatPathBinding | { reason: string } {
  if (!method.path || !method.flatPath) return { reason: "the method declares no flatPath" };
  if (method.path === method.flatPath) {
    return { reason: "flatPath is identical to path, so it binds the same operation" };
  }
  const tokens = tokenizeTemplate(method.path);
  const variables = tokens.filter((t) => t.variable !== undefined);
  if (variables.length === 0) return { reason: "path declares no template variable to expand" };
  // Fit the flatPath to the path template: a reserved variable may span
  // segments (lazily, so neighbouring literals anchor it), a simple one may not.
  const fit = new RegExp(
    `^${tokens
      .map((t) =>
        t.variable !== undefined
          ? t.reserved
            ? "(.+?)"
            : "([^/]+)"
          : escapeRegExp(t.literal ?? ""),
      )
      .join("")}$`,
  );
  const match = fit.exec(method.flatPath);
  if (!match) return { reason: `flatPath '${method.flatPath}' does not fit path '${method.path}'` };

  /** Template parameter name → the path parameters derived from its segments, in URL order. */
  const derived = new Map<string, Array<{ name: string; param: DiscoveryParam }>>();
  const taken = new Set(Object.keys(parameters));
  const expansions: string[] = [];
  let rebuilt = "";
  let captureIndex = 1;
  for (const token of tokens) {
    if (token.variable === undefined) {
      rebuilt += token.literal ?? "";
      continue;
    }
    const name = token.variable;
    const fragment = match[captureIndex++] as string;
    const param = parameters[name];
    if (param?.location !== "path") {
      return { reason: `path variable '${name}' has no declared path parameter` };
    }
    const single = SINGLE_VARIABLE.exec(fragment);
    if (single) {
      // One flatPath variable for one path variable: the same single segment
      // under a synthetic name (`{projectsId}` for `{+projectId}`). Keep the
      // declared parameter so the segment binds — unless the pattern insists
      // the value spans several segments, which a single variable cannot.
      const pattern = param.pattern?.replace(/^\^/, "").replace(/\$$/, "");
      if (pattern !== undefined && pattern !== PATTERN_VARIABLE_SEGMENT) {
        return {
          reason: `flatPath binds '${name}' to the single segment '${fragment}' but its pattern '${param.pattern}' spans several`,
        };
      }
      rebuilt += `{${name}}`;
      continue;
    }
    // The flatPath spells the resource out as literal and variable segments; the
    // parameter's pattern must say the same thing, segment for segment.
    if (!param.pattern) {
      return { reason: `'${name}' expands to '${fragment}' but declares no pattern to verify it` };
    }
    if (!param.pattern.startsWith("^") || !param.pattern.endsWith("$")) {
      return { reason: `pattern '${param.pattern}' of '${name}' is not anchored` };
    }
    // `[^/]+` carries a slash of its own, so mark each group before splitting
    // the pattern into its `/`-separated segments.
    const patternSegments = param.pattern
      .slice(1, -1)
      .replaceAll(PATTERN_VARIABLE_SEGMENT, PATTERN_VARIABLE_MARK)
      .split("/");
    const fragmentSegments = fragment.split("/");
    if (patternSegments.length !== fragmentSegments.length) {
      return {
        reason: `pattern '${param.pattern}' of '${name}' has ${patternSegments.length} segments but flatPath spells ${fragmentSegments.length} ('${fragment}')`,
      };
    }
    const segments: Array<{ name: string; param: DiscoveryParam }> = [];
    for (let i = 0; i < patternSegments.length; i++) {
      const expected = patternSegments[i] as string;
      const actual = fragmentSegments[i] as string;
      if (expected === PATTERN_VARIABLE_MARK) {
        const variable = SINGLE_VARIABLE.exec(actual)?.[1];
        if (!variable) {
          return {
            reason: `pattern '${param.pattern}' of '${name}' expects a variable where flatPath has '${actual}'`,
          };
        }
        if (taken.has(variable)) {
          return {
            reason: `derived path parameter '${variable}' collides with an existing parameter`,
          };
        }
        taken.add(variable);
        const owner = i > 0 ? fragmentSegments[i - 1] : undefined;
        const describes =
          owner !== undefined && PATTERN_LITERAL_SEGMENT.test(owner)
            ? `the \`${owner}\` identifier`
            : `segment ${i + 1}`;
        const description = [
          `${describes[0]?.toUpperCase()}${describes.slice(1)} of \`${name}\` (\`${fragment}\`).`,
          param.description,
        ]
          .filter(Boolean)
          .join(" ");
        segments.push({
          name: variable,
          param: { type: "string", location: "path", required: true, description },
        });
        continue;
      }
      if (!PATTERN_LITERAL_SEGMENT.test(expected) || expected !== actual) {
        return {
          reason: `pattern '${param.pattern}' of '${name}' segment '${expected}' does not match flatPath segment '${actual}'`,
        };
      }
    }
    if (segments.length === 0) {
      return { reason: `pattern '${param.pattern}' of '${name}' binds no variable` };
    }
    derived.set(name, segments);
    expansions.push(`${name} → ${segments.map((s) => s.name).join(", ")}`);
    rebuilt += fragment;
  }
  if (derived.size === 0) {
    return { reason: "flatPath expands no reserved resource template differently from path" };
  }
  // Splice each derived segment set in where its template parameter sat, so the
  // parameter order still follows the URL.
  const rebound: Record<string, DiscoveryParam> = {};
  for (const [name, p] of Object.entries(parameters)) {
    const segments = derived.get(name);
    if (!segments) rebound[name] = p;
    else for (const segment of segments) rebound[segment.name] = segment.param;
  }
  return { path: rebuilt, parameters: rebound, expansions };
}

/** One method, lowered to the coordinates the OpenAPI path map will hold. */
interface LoweredMethod {
  method: DiscoveryMethod;
  verb: string;
  path: string;
  parameters: Record<string, DiscoveryParam>;
  /** Set when the method was re-lowered on its flatPath to escape a collision. */
  flatPath?: FlatPathBinding;
  /** Set when a collision could not be escaped: why the flatPath derivation failed. */
  unbound?: string;
}

export function adaptDiscovery(text: string, diagnostics?: Diagnostic[]): OpenApiDocument {
  let doc: DiscoveryDoc;
  try {
    doc = JSON.parse(text) as DiscoveryDoc;
  } catch (err) {
    throw new Error(`Invalid Google Discovery JSON: ${err instanceof Error ? err.message : err}`);
  }

  const paths: Record<string, Record<string, unknown>> = {};
  const commonParameters = { ...doc.parameters };
  if (Object.keys(doc.auth?.oauth2?.scopes ?? {}).length > 0) {
    // These are alternative credential carriers. The OAuth security scheme
    // below supplies auth; do not project tokens into ordinary agent inputs.
    for (const name of ["access_token", "oauth_token", "key"]) delete commonParameters[name];
  }
  const normalizePath = (template: string) => {
    const raw = template.replace(/\{\+([^{}]+)\}/g, "{$1}");
    return raw.startsWith("/") ? raw : `/${raw}`;
  };
  const lowered: LoweredMethod[] = [];
  for (const method of [...Object.values(doc.methods ?? {}), ...eachMethod(doc.resources)]) {
    // Discovery's `path` uses RFC 6570 level-2 reserved expansion (`{+projectId}`)
    // for segments that may contain slashes, and its placeholder names ARE the
    // declared parameter names (`projectId`, `datasetId`, …). Normalize the `+`
    // away so `{+projectId}` → `{projectId}` matches its param. Do NOT prefer
    // `flatPath`: for reserved-expansion methods Google fills flatPath with
    // synthetic pluralized names (`{projectsId}`, `{datasetsId}`) that DON'T match
    // the parameters, so it would leave every path variable unsubstituted. A
    // `{+name}` (or flatPath's mismatched name) that never binds leaks into the
    // wire URL, and the CLI and MCP surfaces then encode the leftover braces
    // differently (`{+projectId}` vs `%7B+projectId%7D`) — a silent CLI↔MCP
    // divergence the conformance gate catches. The one place flatPath IS used
    // is the verb+path collision below, and there its variables are bound as
    // real path parameters first (`bindFlatPath`), never left as bare names.
    const template = method.path ?? method.flatPath;
    if (!template || !method.httpMethod) continue;
    lowered.push({
      method,
      verb: method.httpMethod.toLowerCase(),
      path: normalizePath(template),
      parameters: { ...commonParameters, ...method.parameters },
    });
  }

  // Reserved resource templates can denote different operations at the same
  // verb/path: BigQuery's tables/routines/rowAccessPolicies `getIamPolicy` all
  // publish `POST {+resource}:getIamPolicy`, Places' get and photos.getMedia
  // both publish `GET v1/{+name}`. Each is a real, distinct REST operation —
  // the `pattern` on the resource parameter and the `flatPath` say which
  // resource each one addresses — but the OpenAPI path map cannot hold two
  // operations at one verb+path. So exactly the colliding methods are
  // re-lowered on their flatPath, with the flatPath's variables bound as real
  // path parameters; non-colliding methods keep `path`, untouched.
  const byEndpoint = new Map<string, LoweredMethod[]>();
  for (const entry of lowered) {
    const key = `${entry.verb} ${entry.path}`;
    const group = byEndpoint.get(key) ?? [];
    group.push(entry);
    byEndpoint.set(key, group);
  }
  for (const group of byEndpoint.values()) {
    if (group.length < 2) continue;
    for (const entry of group) {
      const binding = bindFlatPath(entry.method, entry.parameters);
      if ("reason" in binding) {
        entry.unbound = binding.reason;
        continue;
      }
      entry.flatPath = binding;
      entry.path = normalizePath(binding.path);
      entry.parameters = binding.parameters;
    }
  }

  for (const entry of lowered) {
    const { method, verb, path } = entry;
    const parameters = Object.entries(entry.parameters).map(([name, p]) => toOpenApiParam(name, p));

    const operation: Record<string, unknown> = {
      operationId: method.id,
      summary: method.description,
      parameters,
      responses: {
        "200": {
          description: "Successful response.",
          ...(method.response?.$ref
            ? {
                content: {
                  "application/json": {
                    schema: { $ref: `#/components/schemas/${method.response.$ref}` },
                  },
                },
              }
            : {}),
        },
      },
    };
    if (method.request?.$ref) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${method.request.$ref}` } },
        },
      };
    }
    // Per-method OAuth scopes → a per-operation security requirement, so the
    // pipeline's auth resolution sees each method's REAL scopes (Gmail's send
    // needs gmail.send; its list needs only readonly). Without this every
    // operation inherited the document-level `oauth2: []` and lost its scopes
    // in the generated AIR (finding #27, external review).
    if (method.scopes && method.scopes.length > 0) {
      operation.security = [{ oauth2: method.scopes }];
    }

    const pathItem = paths[path] ?? {};
    // A collision that survives the flatPath rebinding (no flatPath, or a
    // pattern the flatPath cannot be reconciled with) is still a lossy
    // conversion: refuse it, naming why, instead of overwriting whichever
    // method appeared first.
    if (pathItem[verb]) {
      const previous = pathItem[verb] as Record<string, unknown>;
      const why = entry.unbound ? ` flatPath could not bind it: ${entry.unbound}.` : "";
      const message = `Discovery methods '${previous.operationId}' and '${method.id}' share ${verb.toUpperCase()} ${path}. Their resource templates require distinct bindings; conversion would lose an operation.${why}`;
      if (!diagnostics) throw new Error(message);
      diagnostics.push({ level: "error", code: "discovery_endpoint_collision", message, path });
      continue;
    }
    pathItem[verb] = operation;
    paths[path] = pathItem;
    if (entry.flatPath && diagnostics) {
      diagnostics.push({
        level: "info",
        code: "discovery_flatpath_binding",
        message: `Discovery method '${method.id}' shares ${verb.toUpperCase()} ${normalizePath(method.path ?? "")} with another method; lowered on its flatPath ${path} instead, binding ${entry.flatPath.expansions.join("; ")}.`,
        operationId: method.id,
        path,
      });
    }
  }

  const schemas = (rewriteRefs(doc.schemas ?? {}) as Record<string, unknown>) ?? {};

  // OAuth2 with the document's declared scopes — Google APIs are OAuth2, and
  // per-operation scopes exist too but the pipeline reads the scheme type here.
  const scopeMap = doc.auth?.oauth2?.scopes ?? {};
  const oauthScopes: Record<string, string> = {};
  for (const [scope, meta] of Object.entries(scopeMap)) oauthScopes[scope] = meta.description ?? "";

  // Method paths are relative to rootUrl + servicePath (= baseUrl), NOT bare
  // rootUrl. Gmail's servicePath is "" so either works there, but Drive-shaped
  // documents (rootUrl "https://www.googleapis.com/", servicePath "drive/v3/",
  // method path "files") would compile to calls against "/files" instead of
  // "/drive/v3/files" (finding #26, external review). Prefer the document's
  // own precomputed baseUrl; reconstruct it from the parts when absent.
  const server = (
    doc.baseUrl ?? `${doc.rootUrl ?? "https://www.googleapis.com/"}${doc.servicePath ?? ""}`
  ).replace(/\/$/, "");

  return {
    openapi: "3.0.0",
    info: {
      title: doc.title ?? doc.name ?? "google-api",
      version: doc.version ?? "v1",
      description: doc.description,
    },
    servers: [{ url: server }],
    paths,
    components: {
      schemas,
      ...(Object.keys(oauthScopes).length > 0
        ? {
            securitySchemes: {
              oauth2: {
                type: "oauth2",
                flows: {
                  authorizationCode: {
                    authorizationUrl: "https://accounts.google.com/o/oauth2/auth",
                    tokenUrl: "https://oauth2.googleapis.com/token",
                    scopes: oauthScopes,
                  },
                },
              },
            },
          }
        : {}),
    },
    ...(Object.keys(oauthScopes).length > 0 ? { security: [{ oauth2: [] }] } : {}),
  } as OpenApiDocument;
}
