import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { airToJson, loadAirDocument, Operation } from "@anvil/air";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `anvil serve mcp <workspace> --fleet` over stdio, end to end: the BUILT CLI
 * as an MCP client spawns it. `McpServer.connect` resolves as soon as the
 * transport is reading stdin, and the fleet used to close /readyz and every
 * internal bundle client right then, so `initialize` and `tools/list` worked
 * and every `tools/call` answered "Not connected".
 */

const bin = fileURLToPath(new URL("../../dist/bin-anvil.js", import.meta.url));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function op(serviceId: string, toolName: string): Operation {
  return Operation.parse({
    id: `${serviceId}.list`,
    canonicalName: toolName,
    displayName: toolName,
    sourceRef: { kind: "openapi", path: "/things", method: "get" },
    effect: { kind: "read", action: "list", resource: "thing", risk: "low", reversible: false },
    input: { params: [] },
    idempotency: { mode: "natural", mechanism: "none" },
    retries: { mode: "safe", maxAttempts: 1, backoff: "exponential", retryOn: ["timeout"] },
    confirmation: { required: false },
    auth: { type: "none", scopes: [] },
    cli: { command: "things list" },
    mcp: { toolName },
    skill: { intentExamples: [] },
    state: "approved",
  });
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Line-delimited JSON-RPC over the child's stdio. */
function rpc(child: ChildProcessWithoutNullStreams) {
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") waiting.get(message.id)?.(message);
  });
  let next = 1;
  return {
    request(method: string, params: Record<string, unknown> = {}) {
      const id = next++;
      const reply = new Promise<Record<string, unknown>>((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return reply;
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}

describe("anvil serve mcp --fleet over stdio (built CLI)", () => {
  it("keeps /readyz and the fleet up for the session, serves tools/call, and exits when stdin closes", async () => {
    expect(existsSync(bin), `${bin} is missing: build @anvil/cli first`).toBe(true);
    const hits: string[] = [];
    const upstream = createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "inv_1" }]));
    });
    const upstreamPort = await listen(upstream);

    const root = mkdtempSync(join(tmpdir(), "anvil-fleet-stdio-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    for (const [serviceId, toolName] of [
      ["billing", "list_invoices"],
      ["shipping", "list_shipments"],
    ] as const) {
      const air = loadAirDocument({
        service: {
          id: serviceId,
          version: "1.0.0",
          source: { kind: "openapi" },
          servers: [{ url: `http://127.0.0.1:${upstreamPort}` }],
        },
        operations: [op(serviceId, toolName)],
      });
      mkdirSync(join(root, serviceId));
      writeFileSync(join(root, serviceId, "air.json"), airToJson(air), "utf8");
    }

    const readyzPort = await freePort();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("ANVIL_")),
    );
    const child = spawn(process.execPath, [bin, "serve", "mcp", root, "--fleet"], {
      env: {
        ...env,
        ANVIL_FLEET_READYZ_PORT: String(readyzPort),
        ANVIL_ALLOWED_HOSTS: "127.0.0.1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    cleanups.push(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const mcp = rpc(child);

    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fleet-stdio-e2e", version: "0" },
    });
    expect(init.result, stderr).toBeDefined();
    mcp.notify("notifications/initialized");

    const readyz = await fetch(`http://127.0.0.1:${readyzPort}/readyz`);
    expect(readyz.status).toBe(503); // mounted, uncertified
    const body = (await readyz.json()) as { bundles: Array<{ id: string }> };
    expect(body.bundles.map((bundle) => bundle.id)).toEqual(["billing", "shipping"]);

    const listed = (await mcp.request("tools/list")) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((tool) => tool.name).sort()).toEqual([
      "billing__list_invoices",
      "shipping__list_shipments",
    ]);

    const called = (await mcp.request("tools/call", {
      name: "billing__list_invoices",
      arguments: {},
    })) as { result?: { isError?: boolean; content: unknown }; error?: unknown };
    expect(called.error, stderr).toBeUndefined();
    expect(called.result?.isError, JSON.stringify(called.result)).not.toBe(true);
    expect(JSON.stringify(called.result?.content)).toContain("inv_1");
    expect(hits).toEqual(["GET /things"]);

    // /readyz is still up after the call, and stdin closing ends the session.
    expect((await fetch(`http://127.0.0.1:${readyzPort}/readyz`)).status).toBe(503);
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const [code, signal] = await exited;
    clearTimeout(timeout);
    expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
    await expect(fetch(`http://127.0.0.1:${readyzPort}/readyz`)).rejects.toThrow();
  }, 60_000);
});
