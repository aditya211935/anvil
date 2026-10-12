import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@anvil/compiler";
import { processEnvironment } from "@anvil/fuzz";
import { generateBundle, writeBundle } from "@anvil/generators";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBundleNodeModules } from "./bundle-driver.js";

/**
 * The servers a bundle ships, booted for real, sent request targets Node's
 * HTTP parser accepts and the WHATWG URL parser refuses.
 *
 * Both servers parsed `req.url` with `new URL` inside an async listener. On
 * `GET //` that throw became an unhandled rejection and the process exited —
 * with inbound OIDC on, before the token was ever looked at, so anyone who
 * could reach the port could stop it with one `curl http://host//`. Each target
 * here must be a 400, and the server must still be there to answer the next
 * request.
 */

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../../examples/${rel}`, import.meta.url)), "utf8");

const MALFORMED = ["//", "http://[", "http://:80/", "//[", "http://a:99999/"];

const OIDC = {
  ANVIL_INBOUND_AUTH_MODE: "oidc",
  ANVIL_INBOUND_ISSUER: "https://idp.example.com",
  ANVIL_INBOUND_AUDIENCE: "https://connector.example.com",
  // Unresolvable on purpose: nothing below may need a key fetch.
  ANVIL_INBOUND_JWKS_URI: "https://jwks.invalid/keys",
};

let dir: string;
const procs: ChildProcess[] = [];

beforeAll(async () => {
  const air = await compile({
    spec: read("payments/openapi.yaml"),
    manifest: read("payments/anvil.yaml"),
    serviceId: "payments",
  });
  dir = mkdtempSync(join(tmpdir(), "anvil-malformed-target-"));
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

/** Spawn a server with only the given environment and wait for its listening line. */
async function boot(
  entry: string,
  env: Record<string, string>,
  ready: string,
): Promise<{ port: number; child: ChildProcess }> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, entry)], {
    env: processEnvironment({
      PORT: String(port),
      ANVIL_ENV: "dev",
      ANVIL_ALLOWED_HOSTS: "payments.internal.example.com",
      ...env,
    }),
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
  return { port, child };
}

/** One raw request line: `fetch` and `http.request` normalise these targets away. */
async function raw(port: number, target: string): Promise<{ status: number; text: string }> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  let text = "";
  // A server that died mid-request leaves nothing to wait for.
  socket.setTimeout(5_000, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
  return { status: Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1] ?? 0), text };
}

async function expectMalformedRefused(port: number, child: ChildProcess): Promise<void> {
  for (const target of MALFORMED) {
    const reply = await raw(port, target);
    expect(reply.status, target).toBe(400);
    const head = reply.text.slice(0, reply.text.indexOf("\r\n\r\n")).toLowerCase();
    expect(head, target).toContain("content-type: application/json");
    expect(head, target).toContain("x-content-type-options: nosniff");
    expect(reply.text, target).toContain(
      '{"error":{"code":"bad_request","message":"Malformed request target."}}',
    );
  }
  expect((await raw(port, "/healthz")).status).toBe(200);
  expect(child.exitCode).toBe(null);
}

for (const [entry, ready] of [
  ["deploy/runtime/server.js", "payments listening"],
  ["mcp/server-sse.js", "MCP SSE listening"],
] as const) {
  describe(entry, () => {
    it("answers each malformed target 400 and keeps serving, inbound auth off", async () => {
      const { port, child } = await boot(entry, { ANVIL_INBOUND_AUTH_MODE: "none" }, ready);
      await expectMalformedRefused(port, child);
    });

    it("answers each malformed target 400 and keeps serving, inbound OIDC on", async () => {
      const { port, child } = await boot(entry, OIDC, ready);
      await expectMalformedRefused(port, child);
    });
  });
}
