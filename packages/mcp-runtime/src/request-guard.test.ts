import { once } from "node:events";
import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuardedServer, MALFORMED_TARGET, parseRequestTarget } from "./request-guard.js";

/**
 * Request targets Node's HTTP parser accepts and `new URL(target, base)` throws
 * on. Each one, sent to an async listener that parsed it unguarded, was an
 * unhandled rejection that ended the process.
 */
const MALFORMED = ["//", "http://[", "http://:80/", "//[", "http://a:99999/"];

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/**
 * One raw request line over a socket: `fetch` and `http.request` normalise these
 * targets away. `stalled` means the server neither finished nor closed in time.
 */
async function raw(
  port: number,
  target: string,
): Promise<{ status: number; text: string; stalled: boolean }> {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  let text = "";
  let stalled = false;
  socket.setTimeout(3_000, () => {
    stalled = true;
    socket.destroy();
  });
  socket.on("data", (chunk: Buffer) => {
    text += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
  });
  return { status: Number(/^HTTP\/1\.1 (\d{3}) /.exec(text)?.[1] ?? 0), text, stalled };
}

describe("parseRequestTarget", () => {
  it("is undefined for every target the URL parser refuses, never a throw", () => {
    for (const url of MALFORMED) {
      expect(() => new URL(url, "http://localhost"), url).toThrow();
      expect(parseRequestTarget({ url } as IncomingMessage), url).toBeUndefined();
    }
  });

  it("parses an ordinary target, and a missing one as /", () => {
    const url = parseRequestTarget({ url: "/mcp?sessionId=a%20b" } as IncomingMessage);
    expect(url?.pathname).toBe("/mcp");
    expect(url?.searchParams.get("sessionId")).toBe("a b");
    expect(parseRequestTarget({} as IncomingMessage)?.pathname).toBe("/");
  });

  it("lets a listener answer each one 400 over a real socket and keep serving", async () => {
    const port = await listen(
      createGuardedServer(async (req, res) => {
        const url = parseRequestTarget(req);
        res.writeHead(url ? 200 : 400, { "content-type": "application/json" });
        res.end(JSON.stringify(url ? { path: url.pathname } : MALFORMED_TARGET));
      }),
    );
    for (const target of MALFORMED) {
      const reply = await raw(port, target);
      expect(reply.status, target).toBe(400);
      expect(reply.text, target).toContain('{"error":{"code":"bad_request"');
    }
    expect((await raw(port, "/healthz")).status).toBe(200);
  });
});

describe("createGuardedServer", () => {
  it("answers a listener that rejects with a generic 500, and keeps serving", async () => {
    const reported: unknown[] = [];
    const port = await listen(
      createGuardedServer(
        async (req, res) => {
          // The original defect, verbatim: an unguarded parse in an async listener.
          const url = new URL(req.url ?? "/", "http://localhost");
          res.writeHead(200);
          res.end(url.pathname);
        },
        (error) => reported.push(error),
      ),
    );
    for (const target of ["//", "http://["]) {
      const reply = await raw(port, target);
      expect(reply.status, target).toBe(500);
      expect(reply.text.toLowerCase(), target).toContain("x-content-type-options: nosniff");
      expect(reply.text, target).toContain('{"error":{"code":"internal_error"');
      // The error's own text stays in the process.
      expect(reply.text, target).not.toContain("Invalid URL");
    }
    expect(reported).toHaveLength(2);
    expect(reported[0]).toBeInstanceOf(TypeError);
    const ok = await raw(port, "/fine");
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("/fine");
  });

  it("answers a listener that throws synchronously the same way", async () => {
    const port = await listen(
      createGuardedServer(
        (() => {
          throw new Error("synchronous");
        }) as () => Promise<void>,
        () => {},
      ),
    );
    expect((await raw(port, "/")).status).toBe(500);
  });

  it("destroys the socket when a response had already started, so a partial body is not a whole one", async () => {
    const port = await listen(
      createGuardedServer(
        async (_req, res) => {
          res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
          res.write('{"partial":');
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("after headers");
        },
        () => {},
      ),
    );
    const reply = await raw(port, "/");
    expect(reply.status).toBe(200);
    expect(reply.text).not.toContain("internal_error");
    expect(reply.text.endsWith('{"partial":')).toBe(true);
    // Closed by the server, not left open for the client to give up on.
    expect(reply.stalled).toBe(false);
  });

  it("reports through one fixed stderr line by default, never the error's text", async () => {
    const lines: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    try {
      const port = await listen(
        createGuardedServer(async () => {
          throw new Error("ENOENT: /srv/vault/secret.json");
        }),
      );
      expect((await raw(port, "/")).status).toBe(500);
      expect(lines).toEqual([["HTTP request handling failed."]]);
    } finally {
      spy.mockRestore();
    }
  });

  it("survives a reporter that throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const port = await listen(
        createGuardedServer(
          async () => {
            throw new Error("listener");
          },
          () => {
            throw new Error("reporter");
          },
        ),
      );
      expect((await raw(port, "/")).status).toBe(500);
      expect((await raw(port, "/")).status).toBe(500);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
