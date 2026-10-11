import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isLoopbackAddress,
  loopbackRequestRefusal,
  openListenerWarning,
  refuseRebindingRequest,
} from "./loopback-guard.js";

// refuseRebindingRequest reads process.env: a runner that sets either variable must not
// turn the gate off (K_SERVICE) or widen it (ANVIL_INBOUND_ALLOWED_HOSTS) under these tests.
beforeAll(() => {
  vi.stubEnv("K_SERVICE", "");
  vi.stubEnv("ANVIL_INBOUND_ALLOWED_HOSTS", "");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

/** The parts of a request the gate reads: the socket's local address/port and two headers. */
function req(localAddress: string, localPort: number, headers: Record<string, string> = {}) {
  return { socket: { localAddress, localPort }, headers } as unknown as IncomingMessage;
}

describe("isLoopbackAddress", () => {
  it("is 127.0.0.0/8, ::1, and IPv4-mapped 127.x, and nothing else", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.9.10",
      "::1",
      "::ffff:127.0.0.1",
      "::FFFF:127.0.0.2",
    ]) {
      expect(isLoopbackAddress(address), address).toBe(true);
    }
    for (const address of [
      undefined,
      "",
      "10.0.0.5",
      "169.254.8.1",
      "::ffff:10.0.0.5",
      "fe80::1",
      "::",
      "0.0.0.0",
      "128.0.0.1",
    ]) {
      expect(isLoopbackAddress(address), String(address)).toBe(false);
    }
  });
});

describe("loopbackRequestRefusal", () => {
  it("serves a loopback connection whose Host names a loopback address on its own port", () => {
    for (const host of ["127.0.0.1:8080", "localhost:8080", "LocalHost:8080", "[::1]:8080"]) {
      for (const local of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
        expect(loopbackRequestRefusal(req(local, 8080, { host }), {}), `${host} on ${local}`).toBe(
          undefined,
        );
      }
    }
    // No port in Host is port 80.
    expect(loopbackRequestRefusal(req("127.0.0.1", 80, { host: "localhost" }), {})).toBe(undefined);
  });

  it("serves a loopback Host on another port, which only a port forward produces", () => {
    for (const host of [
      "localhost:9090",
      "127.0.0.1:8000",
      "127.0.0.1:08080",
      "localhost",
      "[::1]:1",
    ]) {
      expect(loopbackRequestRefusal(req("127.0.0.1", 8080, { host }), {}), host).toBe(undefined);
    }
  });

  it("leaves Knative's queue-proxy alone: K_SERVICE set, loopback arrival, public Host", () => {
    const r = req("127.0.0.1", 8080, { host: "payments.default.svc.cluster.local" });
    expect(loopbackRequestRefusal(r, { K_SERVICE: "payments" })).toBe(undefined);
    expect(loopbackRequestRefusal(r, {})).toBe("host_not_allowed");
  });

  it("refuses a rebound name or a missing Host on a loopback connection", () => {
    for (const host of [
      "attacker.example:8080",
      "attacker.example",
      "localhost.attacker.example:8080",
      "127.0.0.1.nip.io:8080",
      "[::2]:8080",
      "[::1:8080",
      "",
    ]) {
      expect(loopbackRequestRefusal(req("::ffff:127.0.0.1", 8080, { host }), {}), host).toBe(
        "host_not_allowed",
      );
    }
    expect(loopbackRequestRefusal(req("127.0.0.1", 8080), {})).toBe("host_not_allowed");
  });

  it("refuses an Origin other than this server's own loopback origin", () => {
    const host = "127.0.0.1:8080";
    for (const origin of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "HTTP://LOCALHOST:8080",
      "http://[::1]:8080",
    ]) {
      expect(loopbackRequestRefusal(req("127.0.0.1", 8080, { host, origin }), {}), origin).toBe(
        undefined,
      );
    }
    for (const origin of [
      "http://attacker.example",
      "http://attacker.example:8080",
      "https://localhost:8080",
      "http://localhost:3000",
      "http://localhost",
      "http://localhost:8080/",
      "null",
      "",
    ]) {
      expect(loopbackRequestRefusal(req("127.0.0.1", 8080, { host, origin }), {}), origin).toBe(
        "origin_not_allowed",
      );
    }
  });

  it("leaves Host alone on a connection that arrived on any other address", () => {
    // Cloud Run, a Kubernetes Service, docker -p: the platform's Host is not a browser's.
    for (const local of ["10.4.0.7", "::ffff:172.17.0.2", "fd00::7"]) {
      for (const host of ["payments.run.app", "attacker.example:8080", ""]) {
        expect(loopbackRequestRefusal(req(local, 8080, { host }), {}), `${host} on ${local}`).toBe(
          undefined,
        );
      }
    }
  });

  it("refuses a foreign Origin on a connection that arrived on any other address", () => {
    // A page rebound to this machine's LAN address, or reaching a `docker run -p` port,
    // arrives off the loopback but names itself in Origin on every tool call.
    for (const local of ["10.4.0.7", "::ffff:172.17.0.2", "fd00::7"]) {
      for (const origin of [
        "https://console.example",
        "http://attacker.example:8080",
        "http://localhost:9090",
        "null",
      ]) {
        const r = req(local, 8080, { host: "attacker.example:8080", origin });
        expect(loopbackRequestRefusal(r, {}), `${origin} on ${local}`).toBe("origin_not_allowed");
      }
      const own = req(local, 8080, { host: "payments.run.app", origin: "http://localhost:8080" });
      expect(loopbackRequestRefusal(own, {}), local).toBe(undefined);
    }
    // Knative and Cloud Run are still left alone, Origin included.
    const knative = req("10.4.0.7", 8080, {
      host: "payments.run.app",
      origin: "https://x.example",
    });
    expect(loopbackRequestRefusal(knative, { K_SERVICE: "payments" })).toBe(undefined);
  });

  it("serves a host named in ANVIL_INBOUND_ALLOWED_HOSTS with no Origin or that host's own", () => {
    const env = { ANVIL_INBOUND_ALLOWED_HOSTS: " mcp.example.com , Tools.Example.com:8443," };
    for (const local of ["127.0.0.1", "10.4.0.7"]) {
      for (const [host, origin] of [
        ["mcp.example.com", undefined],
        ["MCP.example.com", "https://mcp.example.com"],
        ["mcp.example.com", "http://mcp.example.com"],
        ["tools.example.com:8443", "https://TOOLS.example.com:8443"],
      ] as const) {
        const headers: Record<string, string> = origin ? { host, origin } : { host };
        expect(loopbackRequestRefusal(req(local, 8080, headers), env), `${host} ${origin}`).toBe(
          undefined,
        );
      }
      for (const origin of [
        "https://attacker.example",
        "http://localhost:8080",
        "https://mcp.example.com:8443",
        "https://mcp.example.com/",
        "null",
      ]) {
        const r = req(local, 8080, { host: "mcp.example.com", origin });
        expect(loopbackRequestRefusal(r, env), origin).toBe("origin_not_allowed");
      }
    }
    // Exact names only: no suffix, no other port, no entry for a bare Host.
    for (const host of [
      "mcp.example.com.attacker.example",
      "attacker-mcp.example.com",
      "mcp.example.com:8080",
      "tools.example.com",
      "",
    ]) {
      expect(loopbackRequestRefusal(req("127.0.0.1", 8080, { host }), env), host).toBe(
        "host_not_allowed",
      );
    }
    // Unset, the public Host of a same-host proxy is a rebound name like any other.
    expect(loopbackRequestRefusal(req("127.0.0.1", 8080, { host: "mcp.example.com" }), {})).toBe(
      "host_not_allowed",
    );
  });
});

describe("refuseRebindingRequest over a real socket", () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((incoming, res) => {
      if (refuseRebindingRequest(incoming, res)) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ tools: ["secret_tool"] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (headers: Record<string, string>) =>
    new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>(
      (resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, path: "/mcp", headers }, (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        r.on("error", reject);
        r.end();
      },
    );

  it("answers a 403 JSON refusal with nosniff, before the route runs", async () => {
    const host = await get({ host: `attacker.example:${port}` });
    expect(host.status).toBe(403);
    expect(host.headers["content-type"]).toBe("application/json");
    expect(host.headers["x-content-type-options"]).toBe("nosniff");
    expect(JSON.parse(host.body)).toMatchObject({ error: { code: "host_not_allowed" } });
    expect(host.body).not.toContain("secret_tool");
    const origin = await get({ host: `127.0.0.1:${port}`, origin: "http://attacker.example" });
    expect(origin.status).toBe(403);
    expect(JSON.parse(origin.body)).toMatchObject({ error: { code: "origin_not_allowed" } });
    expect((await get({ host: `localhost:${port}` })).status).toBe(200);
  });
});

describe("openListenerWarning", () => {
  const line =
    "anvil runtime: inbound auth is off and the server listens on every interface, so anything that can reach this port can call its tools; set ANVIL_INBOUND_AUTH_MODE before it shares a network you do not trust.";

  it("warns only for inbound auth off, every interface, and no Cloud Run or Kubernetes", () => {
    expect(openListenerWarning("none", "::", {})).toBe(line);
    expect(openListenerWarning("none", "0.0.0.0", {})).toBe(line);
    expect(openListenerWarning("oidc", "::", {})).toBe(undefined);
    expect(openListenerWarning("google_service_account", "0.0.0.0", {})).toBe(undefined);
    expect(openListenerWarning("none", "127.0.0.1", {})).toBe(undefined);
    expect(openListenerWarning("none", "::1", {})).toBe(undefined);
    expect(openListenerWarning("none", undefined, {})).toBe(undefined);
    expect(openListenerWarning("none", "::", { K_SERVICE: "payments" })).toBe(undefined);
    expect(openListenerWarning("none", "::", { KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toBe(
      undefined,
    );
    expect(openListenerWarning("none", "::", { K_SERVICE: "", KUBERNETES_SERVICE_HOST: "" })).toBe(
      line,
    );
  });
});
