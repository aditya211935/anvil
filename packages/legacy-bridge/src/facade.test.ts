import { once } from "node:events";
import { createServer, type OutgoingHttpHeaders, request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InProcessBrokerDouble } from "./broker-double.js";
import { createLegacyBridgeFacade, type LegacyBridgeTelemetryRecord } from "./facade.js";
import { fixtureLegacyCapabilityBinding } from "./test-fixtures.js";
import { buildQueueWireBinding, LegacyBridgeShapeError } from "./wire-binding.js";

let closeServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

async function boot(
  double: InProcessBrokerDouble,
  telemetry: LegacyBridgeTelemetryRecord[] = [],
  loopbackOnly?: boolean,
): Promise<string> {
  const binding = fixtureLegacyCapabilityBinding();
  const wireBinding = buildQueueWireBinding(binding);
  const listener = createLegacyBridgeFacade({
    binding,
    wireBinding,
    client: double,
    onTelemetry: (record) => telemetry.push(record),
    ...(loopbackOnly === undefined ? {} : { loopbackOnly }),
  });
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

/** One request over node:http, which (unlike fetch) lets a test choose the `Host` header. */
function send(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: OutgoingHttpHeaders; body?: string } = {},
): Promise<{ status: number; nosniff: boolean; json: { code?: string } }> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${baseUrl}${path}`,
      { method: options.method ?? "POST", headers: options.headers, agent: false },
      (res) => {
        let text = "";
        res.on("data", (chunk: Buffer) => {
          text += chunk.toString("utf8");
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            nosniff: res.headers["x-content-type-options"] === "nosniff",
            json: JSON.parse(text) as { code?: string },
          }),
        );
      },
    );
    // A handler that never answers fails the call in seconds, not the test's 30s.
    req.setTimeout(15_000, () => req.destroy(new Error(`${path} did not answer within 15s`)));
    req.on("error", reject);
    req.end(options.body);
  });
}

/** One raw request line: `fetch` and `http.request` normalise a malformed target away. */
async function rawGet(baseUrl: string, target: string): Promise<string> {
  const { port } = new URL(baseUrl);
  const socket = connect(Number(port), "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  let text = "";
  socket.setTimeout(15_000, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
  return text;
}

describe("createLegacyBridgeFacade", () => {
  it("refuses to construct against an incoherent wire binding", () => {
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    const mismatched = { ...wireBinding, legacyBindingContentHash: `sha256:${"0".repeat(64)}` };
    expect(() =>
      createLegacyBridgeFacade({
        binding,
        wireBinding: mismatched,
        client: new InProcessBrokerDouble(() => ""),
      }),
    ).toThrow(LegacyBridgeShapeError);
  });

  it("proxies one HTTP call to exactly one broker exchange and returns the reply", async () => {
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double);
    const res = await fetch(`${baseUrl}/invoke`, { method: "POST", body: '{"refundId":"r-1"}' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"refundId":"r-1"}');
    expect(double.sendAttempts).toBe(1);
  });

  it("answers /readyz without touching the broker", async () => {
    const double = new InProcessBrokerDouble(() => "unused");
    const baseUrl = await boot(double);
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    expect(double.sendAttempts).toBe(0);
  });

  it("refuses an unknown route with 404 and the wrong method with 405", async () => {
    const double = new InProcessBrokerDouble(() => "unused");
    const baseUrl = await boot(double);
    const missing = await fetch(`${baseUrl}/nope`);
    expect(missing.status).toBe(404);
    const wrongMethod = await fetch(`${baseUrl}/invoke`, { method: "GET" });
    expect(wrongMethod.status).toBe(405);
  });

  it("maps a broker timeout to a structured, non-retryable 504", async () => {
    const binding = fixtureLegacyCapabilityBinding({ timeoutMs: 100 });
    const wireBinding = buildQueueWireBinding(binding);
    const double = new InProcessBrokerDouble(() => "unused", {
      silentDestinations: new Set([wireBinding.requestDestination]),
    });
    const listener = createLegacyBridgeFacade({ binding, wireBinding, client: double });
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${address.port}/invoke`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(504);
    const parsed = (await res.json()) as { code: string; retryable: boolean };
    expect(parsed.code).toBe("upstream_timeout");
    expect(parsed.retryable).toBe(false);
  });

  it("maps a broker transport failure to a stable 502 without leaking the raw exception", async () => {
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    const double = new InProcessBrokerDouble(() => "unused", {
      refusedDestinations: new Set([wireBinding.requestDestination]),
    });
    const baseUrl = await boot2(binding, wireBinding, double);
    const res = await fetch(`${baseUrl}/invoke`, { method: "POST", body: "{}" });
    expect(res.status).toBe(502);
    const parsed = (await res.json()) as { code: string; message: string };
    expect(parsed.code).toBe("upstream_unavailable");
    expect(parsed.message).not.toContain("QueueBrokerTransportError");
  });

  it("emits telemetry with no request payload content", async () => {
    const telemetry: LegacyBridgeTelemetryRecord[] = [];
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double, telemetry);
    await fetch(`${baseUrl}/invoke`, { method: "POST", body: '{"secretField":"do-not-leak"}' });
    expect(telemetry).toHaveLength(1);
    expect(JSON.stringify(telemetry[0])).not.toContain("do-not-leak");
    expect(telemetry[0]?.outcome).toBe("success");
  });

  it("refuses any request carrying an Origin — a web page — and the broker receives nothing", async () => {
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double, [], true);
    // A cross-site "simple" POST (text/plain, no preflight), a sandboxed or
    // privacy-stripped one (`null`), and a same-origin page posting to the
    // facade's own address all carry Origin; so does a CORS GET.
    for (const origin of ["http://evil.example", "null", baseUrl]) {
      const reply = await send(baseUrl, "/invoke", {
        headers: { origin, "content-type": "text/plain" },
        body: '{"refundId":"r-1"}',
      });
      expect(reply.status, origin).toBe(403);
      expect(reply.json.code, origin).toBe("permission_denied");
      expect(reply.nosniff, origin).toBe(true);
    }
    const cors = await send(baseUrl, "/readyz", {
      method: "GET",
      headers: { origin: "http://evil.example" },
    });
    expect(cors.status).toBe(403);
    expect(double.sendAttempts).toBe(0);
  });

  it("bound to loopback, refuses a Host that is not loopback with its own port (DNS rebinding)", async () => {
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double, [], true);
    const port = Number(new URL(baseUrl).port);
    for (const host of [
      "attacker.example",
      `attacker.example:${port}`,
      `127.0.0.1.attacker.example:${port}`,
      `localhost.attacker.example:${port}`,
      `127.0.0.1:${port}.attacker.example`,
      `127.0.0.1:${port + 1}`,
      `localhost:${port + 1}`,
      "127.0.0.1",
    ]) {
      for (const [method, path] of [
        ["POST", "/invoke"],
        ["GET", "/readyz"],
      ] as const) {
        const body = method === "POST" ? "{}" : undefined;
        const reply = await send(baseUrl, path, { method, headers: { host }, body });
        expect(reply.status, `${method} ${host}`).toBe(403);
        expect(reply.json.code, `${method} ${host}`).toBe("permission_denied");
        expect(reply.nosniff, `${method} ${host}`).toBe(true);
      }
    }
    expect(double.sendAttempts).toBe(0);
  });

  it("forwards a runtime-style request — loopback Host, no Origin, with or without a body", async () => {
    const double = new InProcessBrokerDouble((body) => body || "{}");
    const baseUrl = await boot(double, [], true);
    const port = Number(new URL(baseUrl).port);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`]) {
      const reply = await send(baseUrl, "/invoke", {
        headers: { host, "content-type": "application/json", "idempotency-key": `k-${host}` },
        body: '{"refundId":"r-1"}',
      });
      expect(reply.status, host).toBe(200);
      expect(reply.json, host).toEqual({ refundId: "r-1" });
    }
    // No Content-Type rule: a body-less POST (an operation with no input) is served.
    const empty = await send(baseUrl, "/invoke");
    expect(empty.status).toBe(200);
    expect(double.sendAttempts).toBe(4);
  });

  it("serves any Host when not told it is bound to loopback (a deliberate non-loopback bind)", async () => {
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double);
    const reply = await send(baseUrl, "/invoke", {
      headers: { host: "bridge.internal:8080" },
      body: "{}",
    });
    expect(reply.status).toBe(200);
    expect(double.sendAttempts).toBe(1);
  });

  it("answers a request target the URL parser refuses with 400, and keeps serving", async () => {
    // Node's parser admits these and `new URL` throws on them; inside the async
    // handler that was an unhandled rejection, and the bridge process exited.
    const double = new InProcessBrokerDouble((body) => body);
    const baseUrl = await boot(double, [], true);
    for (const target of ["//", "http://[", "http://:80/", "//[", "http://a:99999/"]) {
      const reply = await rawGet(baseUrl, target);
      expect(reply, target).toMatch(/^HTTP\/1\.1 400 /);
      expect(reply.toLowerCase(), target).toContain("x-content-type-options: nosniff");
      expect(reply, target).toContain(
        '{"code":"bad_request","message":"Malformed request target."}',
      );
    }
    expect(double.sendAttempts).toBe(0);
    expect((await send(baseUrl, "/readyz", { method: "GET" })).status).toBe(200);
  });

  it("answers what the handler fails to catch with 500 instead of crashing", async () => {
    // A telemetry sink that throws escapes both the success path and the
    // failure path's own report; the request is still answered, still once.
    const binding = fixtureLegacyCapabilityBinding();
    const wireBinding = buildQueueWireBinding(binding);
    const double = new InProcessBrokerDouble((body) => body);
    const listener = createLegacyBridgeFacade({
      binding,
      wireBinding,
      client: double,
      onTelemetry: () => {
        throw new Error("telemetry sink down");
      },
    });
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const reply = await send(baseUrl, "/invoke", { body: "{}" });
    expect(reply.status).toBe(500);
    expect(reply.nosniff).toBe(true);
    expect(reply.json).toEqual({
      code: "internal_error",
      message: "The bridge failed this request.",
    });
    expect(double.sendAttempts).toBe(1);
    expect((await send(baseUrl, "/readyz", { method: "GET" })).status).toBe(200);
  });

  async function boot2(
    binding: ReturnType<typeof fixtureLegacyCapabilityBinding>,
    wireBinding: ReturnType<typeof buildQueueWireBinding>,
    double: InProcessBrokerDouble,
  ): Promise<string> {
    const listener = createLegacyBridgeFacade({ binding, wireBinding, client: double });
    const server = createServer(listener);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return `http://127.0.0.1:${address.port}`;
  }
});
