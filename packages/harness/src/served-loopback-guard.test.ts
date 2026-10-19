import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, request } from "node:http";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { processEnvironment } from "@anvil/fuzz";
import { generateBundle, writeBundle } from "@anvil/generators";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBundleNodeModules } from "./bundle-driver.js";

/**
 * The servers a bundle ships, booted for real: the prebuilt
 * `deploy/runtime/server.js` and the generated `mcp/server-sse.js`.
 *
 * With inbound auth off, reaching the socket is the only gate, and a web page
 * gets around a loopback bind by re-pointing its own domain at 127.0.0.1 (DNS
 * rebinding). Its browser still sends that domain as `Host`, so a loopback
 * connection is answered only when `Host` names a loopback address (any port:
 * only a port forward renames it) or a host in ANVIL_INBOUND_ALLOWED_HOSTS. A
 * page can rebind to the machine's network address too, so on every connection
 * any `Origin` must be the server's own loopback origin, on the port the
 * connection arrived on (or, for a Host in ANVIL_INBOUND_ALLOWED_HOSTS, that
 * host's own). A connection on another address (what Cloud Run,
 * Kubernetes, and `docker run -p` deliver) keeps its platform `Host`. With
 * inbound auth on, a hostile token is a 401, never a crashed process.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const OPEN_WARNING =
  "anvil runtime: inbound auth is off and the server listens on every interface, so anything that can reach this port can call its tools; set ANVIL_INBOUND_AUTH_MODE before it shares a network you do not trust.";

let dir: string;
const procs: ChildProcess[] = [];

beforeAll(async () => {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-loopback-guard-"));
  writeBundle(dir, generateBundle(air));
  // mcp/server-sse.js imports the runtime packages; the prebuilt server needs none.
  ensureBundleNodeModules(dir);
});

afterAll(() => {
  for (const child of procs) child.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

interface Booted {
  port: number;
  child: ChildProcess;
  stderr: () => string;
}

/** Spawn a server with only the given environment and wait for its listening line. */
async function boot(entry: string, env: Record<string, string>, ready: string): Promise<Booted> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, entry)], {
    env: processEnvironment({ PORT: String(port), ANVIL_ENV: "dev", ...env }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  procs.push(child);
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${entry} did not listen:\n${stderr}`)),
      15_000,
    );
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes(ready)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${entry} exited (${code}) before listening:\n${stderr}`));
    });
  });
  return { port, child, stderr: () => stderr };
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * One raw HTTP exchange with a chosen `Host` (fetch cannot set it). `firstChunk`
 * resolves on the first body bytes, for an event stream that never ends.
 */
function exchange(
  port: number,
  path: string,
  headers: Record<string, string>,
  opts: { method?: string; body?: string; address?: string; firstChunk?: boolean } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: opts.address ?? "127.0.0.1", port, path, method: opts.method ?? "GET", headers },
      (res) => {
        let body = "";
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (opts.firstChunk) {
            done();
            req.destroy();
          }
        });
        res.on("end", done);
      },
    );
    // An event stream answered where a refusal was due would otherwise hang the test.
    req.setTimeout(5_000, () => req.destroy(new Error(`${path} did not answer within 5s`)));
    req.on("error", reject);
    req.end(opts.body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rebinding-page", version: "1" },
  },
});

function expectRefusal(reply: Reply, code: string, label: string): void {
  expect(reply.status, label).toBe(403);
  expect(reply.headers["content-type"], label).toBe("application/json");
  expect(reply.headers["x-content-type-options"], label).toBe("nosniff");
  expect(JSON.parse(reply.body), label).toMatchObject({ error: { code } });
  // Nothing of the tool surface leaks into a refusal.
  expect(reply.body, label).not.toMatch(/payments|refund|create_|"tools"/i);
}

/** A non-loopback IPv4 address of this machine, if it has one. */
const externalIPv4 = Object.values(networkInterfaces())
  .flat()
  .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;

describe("deploy/runtime/server.js with inbound auth off", () => {
  let runtime: Booted;
  beforeAll(async () => {
    runtime = await boot(
      "deploy/runtime/server.js",
      {
        ANVIL_INBOUND_AUTH_MODE: "none",
        ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
        ANVIL_INBOUND_ALLOWED_HOSTS: "mcp.example.com",
      },
      "payments listening",
    );
  });

  it("answers a rebound Host with 403 on every route, before routing", async () => {
    const { port } = runtime;
    const host = `attacker.example:${port}`;
    for (const path of [
      "/healthz",
      "/readyz",
      "/openapi",
      "/metrics",
      "/business/complete_return",
      "/webhooks/payments/anything",
      "/.well-known/oauth-protected-resource",
      "/no-such-route",
    ]) {
      expectRefusal(await exchange(port, path, { host }), "host_not_allowed", path);
    }
    expectRefusal(
      await exchange(
        port,
        "/mcp",
        { host, "content-type": "application/json", accept: "application/json, text/event-stream" },
        { method: "POST", body: INITIALIZE },
      ),
      "host_not_allowed",
      "POST /mcp initialize",
    );
    // A loopback name on another port is a port forward (kubectl, ssh -L): served.
    expect((await exchange(port, "/openapi", { host: `127.0.0.1:${port + 1}` })).status).toBe(200);
  });

  it("answers a foreign Origin with 403, and its own loopback origin normally", async () => {
    const { port } = runtime;
    expectRefusal(
      await exchange(port, "/openapi", {
        host: `127.0.0.1:${port}`,
        origin: "http://attacker.example",
      }),
      "origin_not_allowed",
      "foreign origin",
    );
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const reply = await exchange(port, "/openapi", { host: `localhost:${port}`, origin });
      expect(reply.status, origin).toBe(200);
    }
  });

  it("serves 127.0.0.1 and localhost on its own port, with no Origin, as before", async () => {
    const { port } = runtime;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const health = await exchange(port, "/healthz", { host });
      expect(health.status, host).toBe(200);
      const catalog = await exchange(port, "/openapi", { host });
      expect(catalog.status, host).toBe(200);
      expect(catalog.body, host).toContain("refund");
    }
    const client = new Client({ name: "loopback-guard-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.some((tool) => tool.name.includes("refund"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("serves a host named in ANVIL_INBOUND_ALLOWED_HOSTS from its own origin only", async () => {
    // A same-host reverse proxy delivers to 127.0.0.1 and keeps the public Host.
    const { port } = runtime;
    const host = "mcp.example.com";
    const headerSets: Record<string, string>[] = [
      { host },
      { host, origin: "https://mcp.example.com" },
    ];
    for (const headers of headerSets) {
      const reply = await exchange(port, "/openapi", headers);
      expect(reply.status, JSON.stringify(headers)).toBe(200);
      expect(reply.body).toContain("refund");
    }
    expectRefusal(
      await exchange(port, "/openapi", { host, origin: "https://attacker.example" }),
      "origin_not_allowed",
      "foreign origin on an allowed host",
    );
    expectRefusal(
      await exchange(port, "/openapi", { host: "mcp.example.com.attacker.example" }),
      "host_not_allowed",
      "suffix of an allowed host",
    );
  });

  it.skipIf(!externalIPv4)(
    "leaves Host alone on a non-loopback address, but refuses a foreign Origin there",
    async () => {
      const { port } = runtime;
      const host = "payments-abc123-uc.a.run.app";
      const reply = await exchange(port, "/openapi", { host }, { address: externalIPv4 });
      expect(reply.status).toBe(200);
      expect(reply.body).toContain("refund");
      // A page rebound to this machine's network address names itself in Origin.
      const rebound = `attacker.example:${port}`;
      for (const [path, method, body] of [
        ["/openapi", "GET", undefined],
        ["/mcp", "POST", INITIALIZE],
      ] as const) {
        expectRefusal(
          await exchange(
            port,
            path,
            {
              host: rebound,
              origin: `http://${rebound}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
            { method, body, address: externalIPv4 },
          ),
          "origin_not_allowed",
          `${method} ${path} from a rebound page`,
        );
      }
    },
  );

  it("says once, on stderr, that it listens on every interface with no inbound auth", () => {
    expect(runtime.stderr().split(OPEN_WARNING).length - 1).toBe(1);
  });
});

describe("deploy/runtime/server.js with inbound OIDC", () => {
  let runtime: Booted;
  beforeAll(async () => {
    runtime = await boot(
      "deploy/runtime/server.js",
      {
        ANVIL_INBOUND_AUTH_MODE: "oidc",
        ANVIL_INBOUND_ISSUER: "https://idp.example.com",
        ANVIL_INBOUND_AUDIENCE: "https://connector.example.com",
        // Unresolvable on purpose: every refusal below happens before a key fetch.
        ANVIL_INBOUND_JWKS_URI: "https://jwks.invalid/keys",
        ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
      },
      "payments listening",
    );
  });

  const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const tokenWithAlg = (alg: string) =>
    `${b64url({ alg, typ: "JWT" })}.${b64url({
      iss: "https://idp.example.com",
      aud: "https://connector.example.com",
      sub: "caller",
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.c2lnbmF0dXJl`;

  function expectUnauthorized(reply: Reply, label: string): void {
    expect(reply.status, label).toBe(401);
    expect(reply.headers["x-content-type-options"], label).toBe("nosniff");
    expect(reply.headers["www-authenticate"], label).toMatch(/^Bearer /);
    expect(reply.body, label).not.toContain("refund");
  }

  it("refuses a missing token with 401 and nosniff", async () => {
    const { port } = runtime;
    const reply = await exchange(port, "/openapi", { host: `127.0.0.1:${port}` });
    expectUnauthorized(reply, "no token");
    expect(JSON.parse(reply.body)).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("answers a non-Latin-1 or CR/LF `alg` with 401 and keeps serving", async () => {
    const { port, child } = runtime;
    for (const alg of ["RS€", "RS256\r\nX-Injected: yes", "RS\n256", "\u0000"]) {
      const authorization = `Bearer ${tokenWithAlg(alg)}`;
      for (const [path, method, body] of [
        ["/openapi", "GET", undefined],
        ["/mcp", "POST", INITIALIZE],
      ] as const) {
        const reply = await exchange(
          port,
          path,
          {
            host: `127.0.0.1:${port}`,
            authorization,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          { method, body },
        );
        const label = `${JSON.stringify(alg)} ${method} ${path}`;
        expectUnauthorized(reply, label);
        expect(reply.headers["x-injected"], label).toBeUndefined();
        // Refused on the algorithm, not after a key fetch to jwks.invalid.
        expect(JSON.parse(reply.body).error.message, label).toBe(
          "Unsupported JWT alg (expected RS256 or ES256).",
        );
      }
    }
    const health = await exchange(port, "/healthz", { host: `127.0.0.1:${port}` });
    expect(health.status).toBe(200);
    expect(child.exitCode).toBe(null);
  });

  it("does not gate on Host when a bearer token is the gate", async () => {
    const { port } = runtime;
    const reply = await exchange(port, "/healthz", { host: `attacker.example:${port}` });
    expect(reply.status).toBe(200);
    expect(runtime.stderr()).not.toContain(OPEN_WARNING);
  });
});

describe("mcp/server-sse.js with inbound auth off", () => {
  let sse: Booted;
  beforeAll(async () => {
    sse = await boot(
      "mcp/server-sse.js",
      { ANVIL_INBOUND_AUTH_MODE: "none", ANVIL_ALLOWED_HOSTS: "payments.internal.example.com" },
      "MCP SSE listening",
    );
  });

  it("answers a rebound Host or a foreign Origin with 403 before routing", async () => {
    const { port } = sse;
    const host = `attacker.example:${port}`;
    for (const path of ["/sse", "/healthz", "/readyz", "/nope"]) {
      expectRefusal(await exchange(port, path, { host }), "host_not_allowed", path);
    }
    expectRefusal(
      await exchange(
        port,
        "/messages?sessionId=x",
        { host, "content-type": "application/json" },
        { method: "POST", body: "{}" },
      ),
      "host_not_allowed",
      "POST /messages",
    );
    expectRefusal(
      await exchange(port, "/sse", {
        host: `127.0.0.1:${port}`,
        origin: "http://attacker.example",
      }),
      "origin_not_allowed",
      "foreign origin",
    );
  });

  it("serves 127.0.0.1 and localhost on its own port as before", async () => {
    const { port } = sse;
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await exchange(port, "/healthz", { host })).status, host).toBe(200);
    }
    const stream = await exchange(
      port,
      "/sse",
      { host: `127.0.0.1:${port}`, accept: "text/event-stream" },
      { firstChunk: true },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain("event: endpoint");
    expect(sse.stderr().split(OPEN_WARNING).length - 1).toBe(1);
  });
});
