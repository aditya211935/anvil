import type { AirDocument } from "@anvil/air";
import { operationFileStem } from "./file-stem.js";
import { exampleFromSchema } from "./mock-example.js";

/**
 * Mock generation with provenance (spec: "Mock generation"). Mocks are not
 * random JSON; each scenario records where its payload came from. Here we
 * synthesize from the output schema and documented error responses, which is
 * the lowest-priority-but-always-available source; richer sources (recorded
 * traffic, examples, Postman) are layered in by the harness loop.
 */
export interface MockScenario {
  name: string;
  operationId: string;
  /** Wire coordinates of the operation this scenario answers for. */
  method?: string;
  path?: string;
  status: number;
  provenance: "schema_generated" | "example" | "synthetic";
  body: unknown;
}

export function generateScenarios(air: AirDocument): MockScenario[] {
  const scenarios: MockScenario[] = [];
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    scenarios.push({
      name: `${op.canonicalName}_success`,
      operationId: op.id,
      method: (op.sourceRef.method ?? "get").toUpperCase(),
      path: op.sourceRef.path ?? "/",
      status: op.effect.kind === "mutation" ? 201 : 200,
      provenance: "schema_generated",
      body: exampleFromSchema(op.output.schema),
    });
    for (const err of op.errors) {
      const status = err.upstream?.httpStatus;
      if (!status || status < 400) continue;
      scenarios.push({
        name: `${op.canonicalName}_${err.code}`,
        operationId: op.id,
        method: (op.sourceRef.method ?? "get").toUpperCase(),
        path: op.sourceRef.path ?? "/",
        status,
        provenance: "synthetic",
        body: { error: { code: err.code, message: err.message ?? err.code } },
      });
    }
  }
  return scenarios;
}

/**
 * One entry of the mock's routing table: the wire contract of an approved
 * operation, projected from AIR at build time so the emitted server can route
 * and validate without parsing AIR itself. Written to `mock/routes.json`.
 */
export interface MockRoute {
  operationId: string;
  canonicalName: string;
  method: string;
  /** REST path template, e.g. /payments/{payment_id}/refunds. */
  path: string;
  pathParams: string[];
  queryParams: string[];
  requiredQuery: string[];
  headerParams: string[];
  /**
   * The request-body contract, when the operation expects one. `schemaType` is
   * the body schema's declared top-level type — a body is not always a JSON
   * object (Jira's addWatcher takes a bare JSON string); absent means untyped.
   */
  body?: { required: boolean; contentType: string; requiredFields: string[]; schemaType?: string };
  /** The per-operation input schema shipped in the bundle, for reference. */
  schemaRef: string;
}

export function generateMockRoutes(air: AirDocument): MockRoute[] {
  const routes: MockRoute[] = [];
  for (const op of air.operations) {
    if (op.state !== "approved") continue;
    const byIn = (where: string) => op.input.params.filter((p) => p.in === where);
    const route: MockRoute = {
      operationId: op.id,
      canonicalName: op.canonicalName,
      method: (op.sourceRef.method ?? "get").toUpperCase(),
      path: op.sourceRef.path ?? "/",
      pathParams: byIn("path").map((p) => p.name),
      queryParams: byIn("query").map((p) => p.name),
      requiredQuery: byIn("query")
        .filter((p) => p.required)
        .map((p) => p.name),
      headerParams: byIn("header").map((p) => p.name),
      schemaRef: `schemas/${operationFileStem(op.id)}.schema.json`,
    };
    const body = op.input.body;
    // Legacy AIR still carries body fields as in:"body" params — honor them so
    // an old bundle's mock validates the same body the executor sends.
    const legacyBody = byIn("body");
    if (body) {
      route.body = {
        required: body.required,
        contentType: body.contentType,
        requiredFields:
          body.projection === "fields"
            ? body.fields.filter((f) => f.required).map((f) => f.name)
            : ((body.schema.required as string[] | undefined) ?? []),
      };
      if (typeof body.schema.type === "string") route.body.schemaType = body.schema.type;
    } else if (legacyBody.length > 0) {
      route.body = {
        required: legacyBody.some((p) => p.required),
        contentType: "application/json",
        requiredFields: legacyBody.filter((p) => p.required).map((p) => p.name),
        schemaType: "object", // in:"body" params are fields of one JSON object
      };
    }
    routes.push(route);
  }
  return routes;
}

export function generateMockServerSource(air: AirDocument): string {
  return `#!/usr/bin/env node
// Generated mock server for "${air.service.id}". Routes each request against
// the AIR-derived table in routes.json, validates it against the operation's
// input contract, and replays recorded scenarios — so the generated MCP/CLI
// path can be proven end-to-end without the real upstream. Control endpoints
// live under the reserved /__anvil/ prefix (capture, reset, scenario, fault,
// oauth/token). The token endpoint is a hermetic dev issuer and is never part
// of the captured upstream operation stream. Its redacted grant metadata proves
// local wiring only; it can never establish live IdP readiness.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scenarios = JSON.parse(
  readFileSync(fileURLToPath(new URL("./scenarios.json", import.meta.url)), "utf8"),
);
const routes = JSON.parse(
  readFileSync(fileURLToPath(new URL("./routes.json", import.meta.url)), "utf8"),
);

// Auth material must never be stored, even by a mock (safety contract §18).
const REDACT = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);
const redactHeaders = (raw) => {
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = REDACT.has(k.toLowerCase()) ? "***" : v;
  return out;
};

// Mutable mock state, all resettable via POST /__anvil/reset.
const CAPTURE_LIMIT = 500;
let captures = [];
let tokenExchanges = [];
let scenarioOverride = process.env.ANVIL_MOCK_SCENARIO ?? null;
let faults = new Map(); // operationId -> { status, times }

// Loopback unless ANVIL_MOCK_HOST names another address: anyone who reaches the
// mock can read its captures and steer its scenarios and faults.
const MOCK_HOST = process.env.ANVIL_MOCK_HOST || "127.0.0.1";
const LOOPBACK_BIND = ["127.0.0.1", "::1", "localhost"].includes(MOCK_HOST);

// A web page can still reach a loopback mock: a plain-text POST needs no CORS
// preflight, and DNS rebinding makes a GET same-origin. The control routes refuse
// any request that carries an Origin header (browsers send one, Node clients do
// not) and, on a loopback bind, any Host that is not a loopback name.
function controlRefusal(req) {
  if (req.headers.origin !== undefined) return "The control routes do not answer browser requests.";
  if (!LOOPBACK_BIND) return undefined;
  const host = String(req.headers.host ?? "").toLowerCase().replace(/:[0-9]+$/, "");
  return ["127.0.0.1", "localhost", "[::1]"].includes(host)
    ? undefined
    : "The control routes answer only a loopback Host.";
}

/**
 * Match one template segment against a concrete (percent-decoded) segment.
 * A {param} may be embedded inside a segment with literal prefix/suffix
 * (Twilio's "{Sid}.json"); literals must match exactly, params are non-empty.
 */
function matchSegment(tseg, seg, params) {
  let pattern = "^";
  const names = [];
  for (const part of tseg.split(/(\\{[^}]+\\})/).filter((s) => s.length > 0)) {
    const m = /^\\{(.+)\\}$/.exec(part);
    if (m) {
      names.push(m[1]);
      pattern += "(.+?)";
    } else {
      pattern += part.replace(/[.*+?^$\\{\\}()|[\\]\\\\]/g, "\\\\$&");
    }
  }
  const match = new RegExp(pattern + "$").exec(seg);
  if (!match) return false;
  names.forEach((name, i) => { params[name] = match[i + 1]; });
  return true;
}

/** The query as a record; a key repeated on the wire (an exploded array) is an array. */
function queryCapture(params) {
  const out = {};
  for (const [name, value] of params) {
    const existing = out[name];
    if (existing === undefined) out[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[name] = [existing, value];
  }
  return out;
}

/** Match a path template against a concrete path; returns captured params or null. */
function matchPath(template, path) {
  const t = template.split("/").filter(Boolean);
  const p = path.split("/").filter(Boolean);
  if (t.length !== p.length) return null;
  const params = {};
  for (let i = 0; i < t.length; i++) {
    let seg;
    try { seg = decodeURIComponent(p[i]); } catch { seg = p[i]; }
    if (!matchSegment(t[i], seg, params)) return null;
  }
  return params;
}

/**
 * Template specificity for deterministic routing on ambiguity: the most
 * literal template wins (full-literal segment > embedded param > bare param),
 * ties broken lexicographically so routing never depends on table order.
 */
function specificity(template) {
  let score = 0;
  for (const seg of template.split("/").filter(Boolean)) {
    score += seg.includes("{") ? (/^\\{[^}]+\\}$/.test(seg) ? 0 : 1) : 2;
  }
  return score;
}

/** Rough similarity for 404 hints: shared leading path segments, then method. */
function nearest(method, path) {
  const segs = path.split("/").filter(Boolean);
  const score = (r) => {
    const t = r.path.split("/").filter(Boolean);
    let shared = 0;
    while (shared < Math.min(t.length, segs.length) && (t[shared] === segs[shared] || t[shared].startsWith("{"))) shared++;
    return shared * 2 + (r.method === method.toUpperCase() ? 1 : 0);
  };
  return [...routes]
    .sort((a, b) => score(b) - score(a))
    .slice(0, 3)
    .map((r) => ({ operationId: r.operationId, method: r.method, path: r.path }));
}

/**
 * A body's JSON type must match the contract's declared top-level schema type.
 * Not every body is an object — Jira's addWatcher is a bare JSON string, and
 * an untyped contract (no declared type) accepts any JSON value.
 */
function bodyTypeMatches(schemaType, body) {
  switch (schemaType) {
    case "object": return typeof body === "object" && body !== null && !Array.isArray(body);
    case "array": return Array.isArray(body);
    case "string": return typeof body === "string";
    case "integer":
    case "number": return typeof body === "number";
    case "boolean": return typeof body === "boolean";
    default: return true;
  }
}

/** The media type of a content-type value: lower-cased, parameters dropped. */
function mediaTypeOf(value) {
  return String(value ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Decode the body the way its content type says, so the contract is checked
 * against what the bytes mean: a form body is a map of fields (a repeated key
 * is an array, as the capture records query strings), not a failed JSON parse;
 * a multipart body is recorded raw and checked for presence only, since its
 * parts are not parsed here. Anything else — JSON, +json, or an undeclared
 * type — is JSON. The header on the wire wins; the contract's declared type is
 * the fallback for a client that sent none.
 */
function decodeBody(rawBody, contentType, route) {
  if (rawBody.length === 0) return { body: undefined, kind: "none" };
  const media = mediaTypeOf(contentType) || mediaTypeOf(route?.body?.contentType);
  if (media === "application/x-www-form-urlencoded") {
    return { body: queryCapture(new URLSearchParams(rawBody)), kind: "form" };
  }
  if (media === "multipart/form-data") return { body: rawBody, kind: "multipart" };
  try {
    return { body: JSON.parse(rawBody), kind: "json" };
  } catch {
    return { body: undefined, kind: "json", error: "request body is not valid JSON" };
  }
}

/** Validate a matched request against the operation's input contract. */
function validate(route, query, decoded) {
  const missing = [];
  const invalid = [];
  for (const q of route.requiredQuery) {
    if (!query.has(q)) missing.push(\`query.\${q}\`);
  }
  const body = decoded.body;
  if (route.body) {
    if (decoded.error) invalid.push(\`body: \${decoded.error}\`);
    else if (body === undefined) {
      if (route.body.required) missing.push("body");
    } else if (decoded.kind === "multipart") {
      // Parts are not parsed: presence is all this mock can attest to.
    } else if (decoded.kind === "form") {
      // A form is always a map of fields; the contract must describe one.
      if (route.body.schemaType !== undefined && route.body.schemaType !== "object") {
        invalid.push(\`body: a form-urlencoded body is a map of fields, but the contract expects a \${route.body.schemaType}\`);
      } else {
        for (const f of route.body.requiredFields) {
          if (body[f] === undefined) missing.push(\`body.\${f}\`);
        }
      }
    } else if (!bodyTypeMatches(route.body.schemaType, body)) {
      invalid.push(\`body: expected a JSON \${route.body.schemaType ?? "value"}\`);
    } else if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      for (const f of route.body.requiredFields) {
        if (body[f] === undefined || body[f] === null) missing.push(\`body.\${f}\`);
      }
    }
  } else if (body !== undefined) {
    invalid.push("body: this operation does not accept a request body");
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function scenarioFor(route) {
  const forOp = scenarios.filter((s) => s.operationId === route.operationId);
  if (scenarioOverride) {
    const override = forOp.find((s) => s.name === scenarioOverride);
    if (override) return override;
  }
  return forOp.find((s) => s.name === \`\${route.canonicalName}_success\`) ?? forOp[0];
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function control(req, res, url, rawBody) {
  if (req.method === "POST" && url.pathname === "/__anvil/oauth/token") {
    const form = new URLSearchParams(rawBody);
    const grant = form.get("grant_type");
    const supported = new Set([
      "client_credentials",
      "urn:ietf:params:oauth:grant-type:token-exchange",
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    ]);
    if (!grant || !supported.has(grant)) {
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (grant === "urn:ietf:params:oauth:grant-type:token-exchange") {
      const authorization = req.headers.authorization;
      const clientAuth =
        typeof authorization === "string" && authorization.startsWith("Basic ")
          ? "client_secret_basic"
          : form.has("client_secret")
            ? "client_secret_post"
            : form.has("client_assertion")
              ? "private_key_jwt"
              : "unknown";
      tokenExchanges.push({
        grantType: grant,
        subjectTokenPresent: form.has("subject_token"),
        subjectTokenType: form.get("subject_token_type"),
        requestedTokenType: form.get("requested_token_type"),
        audience: form.get("audience"),
        resource: form.get("resource"),
        scopes: (form.get("scope") ?? "").split(/\\s+/).filter(Boolean),
        actorTokenPresent: form.has("actor_token"),
        clientAuth,
      });
      if (tokenExchanges.length > CAPTURE_LIMIT) tokenExchanges.shift();
    }
    return json(res, 200, {
      access_token: "anvil-hermetic-upstream-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }
  const parsed = rawBody ? JSON.parse(rawBody) : {};
  if (req.method === "GET" && url.pathname === "/__anvil/capture") {
    return json(res, 200, { requests: captures, tokenExchanges });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/reset") {
    captures = [];
    tokenExchanges = [];
    faults = new Map();
    scenarioOverride = process.env.ANVIL_MOCK_SCENARIO ?? null;
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/scenario") {
    if (parsed.name !== null && !scenarios.some((s) => s.name === parsed.name)) {
      return json(res, 400, { error: { code: "unknown_scenario", name: parsed.name } });
    }
    scenarioOverride = parsed.name;
    return json(res, 200, { ok: true, scenario: scenarioOverride });
  }
  if (req.method === "POST" && url.pathname === "/__anvil/fault") {
    if (!routes.some((r) => r.operationId === parsed.opId)) {
      return json(res, 400, { error: { code: "unknown_operation", opId: parsed.opId } });
    }
    const status = parsed.status ?? 503;
    // json() throws on a status Node cannot write, in the next matched request: refuse it here.
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return json(res, 400, {
        error: { code: "bad_control_request", message: "status must be an HTTP status from 100 to 599." },
      });
    }
    faults.set(parsed.opId, { status, times: parsed.times ?? 1 });
    return json(res, 200, { ok: true, opId: parsed.opId });
  }
  return json(res, 404, { error: { code: "unknown_control_endpoint", path: url.pathname } });
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // Node's parser admits targets the URL parser refuses (\`GET //\`); thrown
    // here, in an event handler, that would end the mock.
    let url;
    try {
      url = new URL(req.url ?? "/", "http://mock.local");
    } catch {
      return json(res, 400, { error: { code: "bad_request", message: "Malformed request target." } });
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    if (url.pathname.startsWith("/__anvil/")) {
      const refusal = controlRefusal(req);
      if (refusal) return json(res, 403, { error: { code: "forbidden", message: refusal } });
      try {
        return control(req, res, url, rawBody);
      } catch (err) {
        return json(res, 400, { error: { code: "bad_control_request", message: String(err) } });
      }
    }

    // Route: method + template match. WSDL-lowered services may share one
    // path+POST, so ambiguity is legal — the most literal template wins, all
    // candidates are recorded so a self-test can disambiguate per call.
    const candidates = routes
      .filter(
        (r) => r.method === (req.method ?? "GET").toUpperCase() && matchPath(r.path, url.pathname),
      )
      .sort((a, b) => specificity(b.path) - specificity(a.path) || (a.path < b.path ? -1 : 1));
    const route = candidates[0];

    const decoded = decodeBody(rawBody, req.headers["content-type"], route);
    const body = decoded.body;
    const query = url.searchParams;
    const validation = route
      ? validate(route, query, decoded)
      : { ok: false, missing: [], invalid: [] };

    const record = {
      ts: new Date().toISOString(),
      method: req.method ?? "GET",
      url: req.url ?? "/",
      path: url.pathname,
      query: queryCapture(query),
      headers: redactHeaders(req.headers),
      credentialKind:
        req.headers.authorization === "Bearer anvil-hermetic-upstream-token"
          ? "hermetic_exchanged_bearer"
          : req.headers.authorization
            ? "redacted_other"
            : "none",
      contentType: req.headers["content-type"] ?? null,
      body: body ?? (rawBody.length > 0 ? rawBody : null),
      matchedOpId: route?.operationId ?? null,
      matchedCandidates: candidates.map((r) => r.operationId),
      pathParams: route ? matchPath(route.path, url.pathname) : null,
      validation,
      response: null,
    };
    captures.push(record);
    if (captures.length > CAPTURE_LIMIT) captures.shift();

    if (!route) {
      record.response = { status: 404, kind: "no_route" };
      return json(res, 404, {
        error: {
          code: "mock_no_route",
          message: \`No approved operation matches \${req.method} \${url.pathname}.\`,
          candidates: nearest(req.method ?? "GET", url.pathname),
        },
      });
    }

    // Injected faults take precedence: "the next N matched requests fail".
    const fault = faults.get(route.operationId);
    if (fault && fault.times > 0) {
      fault.times -= 1;
      record.response = { status: fault.status, kind: "fault" };
      return json(res, fault.status, {
        error: { code: "injected_fault", operation: route.operationId, status: fault.status },
      });
    }

    if (!validation.ok) {
      record.response = { status: 400, kind: "validation_error" };
      return json(res, 400, {
        error: {
          code: "mock_validation_failed",
          operation: route.operationId,
          missing: validation.missing,
          invalid: validation.invalid,
        },
      });
    }

    const pick = scenarioFor(route);
    record.response = { status: pick?.status ?? 200, kind: "scenario", scenario: pick?.name };
    return json(res, pick?.status ?? 200, pick?.body ?? {});
  });
}).listen(Number(process.env.PORT ?? 8081), MOCK_HOST, function () {
  // Machine-readable ready line so a runner can use PORT=0 ephemeral ports.
  console.error(JSON.stringify({ event: "listening", port: this.address().port }));
});
`;
}
