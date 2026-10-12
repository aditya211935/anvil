import { once } from "node:events";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_ROUTES, type ConsoleRoute, zErrorEnvelope } from "../contract.js";
import { type Client, paymentsWorkspace, startServer, type Workspace } from "./fixture.js";
import { createConsoleServer } from "./index.js";

/**
 * The SECURITY block of contract.ts, one test per line. These are the only
 * defenses between a page in another tab and an approval, so each is asserted
 * from the outside — over a real socket, with the header deliberately wrong —
 * and the mutation gate (tools/mutation/mutants.json) deletes the token,
 * origin, and path-containment checks to prove these tests notice.
 */

let ws: Workspace;
let client: Client;
let server: Awaited<ReturnType<typeof startServer>>["server"];
let log: string[];

const APPROVE = "/api/bundles/payments/operations/approve";
const BODY = { ids: ["payments.nope"] };

beforeAll(async () => {
  ws = await paymentsWorkspace();
  const started = await startServer(ws.root);
  client = started.client;
  server = started.server;
  log = started.log;
});

afterAll(async () => {
  await server.close();
  rmSync(ws.root, { recursive: true, force: true });
});

function expectForbidden(reply: { status: number; json: unknown; headers: Headers }): void {
  expect(reply.status).toBe(403);
  expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/forbidden");
  expect(reply.headers.get("access-control-allow-origin")).toBeNull();
  expect(reply.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("1. bind 127.0.0.1 only", () => {
  it("refuses to construct on any other host", () => {
    for (const host of ["0.0.0.0", "localhost", "::", "192.168.0.1", ""]) {
      expect(() => createConsoleServer({ root: ws.root, host }), host).toThrow(/127\.0\.0\.1 only/);
    }
  });

  it("listens on 127.0.0.1 and names that origin", () => {
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("2. the per-process token", () => {
  it("is 32 random bytes as hex, distinct per server", () => {
    expect(server.token).toMatch(/^[0-9a-f]{64}$/);
    const other = createConsoleServer({ root: ws.root });
    expect(other.token).not.toBe(server.token);
  });

  it("refuses a non-GET without the header, or with a wrong one", async () => {
    expectForbidden(await client.post(APPROVE, BODY, { token: null }));
    expectForbidden(await client.post(APPROVE, BODY, { token: "0".repeat(64) }));
    expectForbidden(await client.post(APPROVE, BODY, { token: server.token.slice(0, 63) }));
    expectForbidden(await client.post(APPROVE, BODY, { token: `${server.token}0` }));
  });

  it("refuses before the body is read: a 10 MiB body behind no token is never consumed", async () => {
    const TEN_MIB = 10 * 1024 * 1024;
    const socket = connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST ${APPROVE} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
        `Origin: ${server.url}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${TEN_MIB}\r\n\r\n`,
    );
    let written = 0;
    let response = "";
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      socket.on("close", done);
      socket.on("error", done);
      const pump = (): void => {
        while (written < TEN_MIB && socket.writable && !socket.destroyed) {
          written += chunk.length;
          if (!socket.write(chunk)) {
            socket.once("drain", pump);
            return;
          }
        }
        if (written >= TEN_MIB) socket.end();
      };
      pump();
    });
    expect(response).toMatch(/^HTTP\/1\.1 403 /);
    expect(response.toLowerCase()).toContain("connection: close");
    expect(response).toContain('"console/forbidden"');
    // The server closed the connection without draining the body: far less
    // than the declared 10 MiB ever left the client (only what the kernel's
    // socket buffers absorbed).
    expect(written).toBeLessThan(TEN_MIB / 2);
  });
});

describe("3. same-origin only", () => {
  it("refuses a non-GET whose Origin is absent or not the server's own", async () => {
    expectForbidden(await client.post(APPROVE, BODY, { origin: null }));
    expectForbidden(await client.post(APPROVE, BODY, { origin: "http://evil.example" }));
    expectForbidden(
      await client.post(APPROVE, BODY, { origin: `http://localhost:${server.port}` }),
    );
    expectForbidden(await client.post(APPROVE, BODY, { origin: `${server.url}/` }));
    expectForbidden(await client.post(APPROVE, BODY, { origin: "null" }));
  });

  it("refuses a Sec-Fetch-Site other than same-origin/none even with a matching Origin", async () => {
    for (const site of ["cross-site", "same-site"]) {
      expectForbidden(await client.post(APPROVE, BODY, { headers: { "sec-fetch-site": site } }));
    }
    // With the token and origin right, same-origin/none reach the handler (a
    // refusal for the unknown id, not the gate's 403).
    for (const site of ["same-origin", "none"]) {
      const reply = await client.post(APPROVE, BODY, { headers: { "sec-fetch-site": site } });
      expect(reply.status, site).toBe(409);
    }
  });
});

describe("4. no CORS, ever", () => {
  it("answers a preflight with a refusal carrying no Access-Control header", async () => {
    const reply = await client.send("OPTIONS", APPROVE, undefined, {
      token: null,
      origin: "http://evil.example",
      headers: {
        "access-control-request-method": "POST",
        "access-control-request-headers": "x-anvil-console-token,content-type",
      },
    });
    expect(reply.status).toBe(403);
    for (const [name] of reply.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
  });

  it("emits no Access-Control header on any GET or mutation response", async () => {
    const get = await client.get("/api/workspace", { origin: "http://evil.example" });
    expect(get.status).toBe(200);
    for (const [name] of get.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
    const post = await client.post(APPROVE, BODY);
    for (const [name] of post.headers) expect(name.toLowerCase()).not.toMatch(/^access-control-/);
  });
});

describe("5. JSON bodies only, capped, validated", () => {
  it("refuses a non-JSON content type with 415", async () => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", null]) {
      const reply = await client.post(APPROVE, undefined, {
        raw: JSON.stringify(BODY),
        contentType,
      });
      expect(reply.status, String(contentType)).toBe(415);
      expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/unsupported_media_type");
    }
    const withCharset = await client.post(APPROVE, undefined, {
      raw: JSON.stringify(BODY),
      contentType: "application/json; charset=utf-8",
    });
    expect(withCharset.status).toBe(409);
  });

  it("refuses a body over 1 MiB with 413, declared or streamed", async () => {
    const big = JSON.stringify({ ids: ["x".repeat(2 * 1024 * 1024)] });
    const declared = await client.post(APPROVE, undefined, { raw: big });
    expect(declared.status).toBe(413);
    expect(zErrorEnvelope.parse(declared.json).error.code).toBe("console/payload_too_large");

    // Chunked transfer: no Content-Length to reject up front, so the cap must
    // hold while the body streams in.
    const socket = connect(server.port, "127.0.0.1");
    await once(socket, "connect");
    socket.write(
      `POST ${APPROVE} HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n` +
        `Origin: ${server.url}\r\nX-Anvil-Console-Token: ${server.token}\r\n` +
        "Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n",
    );
    // The server answers 413 the moment the stream crosses the cap and then
    // destroys the socket without draining the rest. A destroy with unread
    // inbound bytes is a TCP reset, and a reset can discard response bytes the
    // client has not read yet — so the client must stop writing as soon as the
    // status line arrives and must yield between writes so that read can
    // happen. Waiting for "close" alone races the reset and reads nothing.
    let response = "";
    const piece = "x".repeat(64 * 1024);
    await new Promise<void>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        response += chunk.toString("utf8");
        if (/^HTTP\//.test(response)) resolve();
      });
      socket.on("close", resolve);
      socket.on("error", resolve);
      let sent = 0;
      const pump = (): void => {
        if (
          response.length > 0 ||
          sent >= 3 * 1024 * 1024 ||
          !socket.writable ||
          socket.destroyed
        ) {
          return;
        }
        sent += piece.length;
        const flushed = socket.write(`${piece.length.toString(16)}\r\n${piece}\r\n`);
        if (flushed) setImmediate(pump);
        else socket.once("drain", pump);
      };
      pump();
    });
    socket.destroy();
    expect(response).toMatch(/^HTTP\/1\.1 413 /);
  });

  it("refuses malformed JSON and a body that fails the route schema, before any library call", async () => {
    const malformed = await client.post(APPROVE, undefined, { raw: "{not json" });
    expect(malformed.status).toBe(400);
    expect(zErrorEnvelope.parse(malformed.json).error.code).toBe("console/invalid_json");

    const invalid = await client.post(APPROVE, { ids: [] });
    expect(invalid.status).toBe(400);
    const envelope = zErrorEnvelope.parse(invalid.json);
    expect(envelope.error.code).toBe("console/invalid_request");
    expect(envelope.error.issues?.length).toBeGreaterThan(0);

    const decision = await client.post(`/api/bundles/payments/packs/${"0".repeat(64)}/decisions`, {
      decision: "approve",
      refinementIds: ["r"],
      reviewer: "",
      reason: "",
    });
    expect(decision.status).toBe(400);
  });
});

describe("the manifest write is a mutation like any other", () => {
  it("is refused without the token or from another origin, and the file is never touched", async () => {
    const path = join(ws.bundleDir, ".anvil", "manifest.yaml");
    const body = { text: "operations: {}\n" };
    const noToken = await client.post("/api/bundles/payments/manifest", body, { token: null });
    expect(noToken.status).toBe(403);
    expect(zErrorEnvelope.parse(noToken.json).error.code).toBe("console/forbidden");
    const otherOrigin = await client.post("/api/bundles/payments/manifest", body, {
      origin: "http://localhost:1",
    });
    expect(otherOrigin.status).toBe(403);
    const validate = await client.post("/api/bundles/payments/manifest/validate", body, {
      token: null,
    });
    expect(validate.status).toBe(403);
    expect(existsSync(path)).toBe(false);
    const ok = await client.post("/api/bundles/payments/manifest", body);
    expect(ok.status, ok.text).toBe(200);
    expect(existsSync(path)).toBe(true);
  });
});

describe("6. paths stay inside the workspace root", () => {
  it("refuses request-body paths that resolve outside the root", async () => {
    const outside = join(tmpdir(), "anvil-console-outside.json");
    for (const taskPath of ["../outside.json", "../../etc/passwd", outside, "/etc/passwd"]) {
      const reply = await client.post("/api/bundles/payments/tasks/import", {
        taskPath,
        submissionPath: "submission.json",
      });
      expect(reply.status, taskPath).toBe(400);
      expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/path_outside_root");
    }
    const outFile = await client.post("/api/bundles/payments/clusters/cc_x/export-task", {
      outFile: "../task.json",
    });
    expect(outFile.status).toBe(400);
    expect(zErrorEnvelope.parse(outFile.json).error.code).toBe("console/path_outside_root");
    const repo = await client.post("/api/bundles/payments/clusters/cc_x/export-task", {
      repositoryRoot: "..",
    });
    expect(zErrorEnvelope.parse(repo.json).error.code).toBe("console/path_outside_root");
  });

  it("follows symlinks when deciding what is inside", async () => {
    mkdirSync(join(ws.root, "links"), { recursive: true });
    symlinkSync(tmpdir(), join(ws.root, "links", "tmp"));
    const reply = await client.post("/api/bundles/payments/tasks/import", {
      taskPath: "links/tmp/anything.json",
      submissionPath: "submission.json",
    });
    expect(reply.status).toBe(400);
    expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/path_outside_root");
  });

  it("names a path inside the root that does not exist as a bad request, not an escape", async () => {
    const reply = await client.post("/api/bundles/payments/tasks/import", {
      taskPath: "absent/task.json",
      submissionPath: "absent/submission.json",
    });
    expect(reply.status).toBe(400);
    expect(zErrorEnvelope.parse(reply.json).error.code).toBe("console/invalid_request");
  });
});

/** One raw HTTP/1.1 exchange with the `Host` line chosen by the test (`null` sends none, as HTTP/1.0). */
async function rawRequest(
  method: "GET" | "POST",
  path: string,
  host: string | null,
  extra: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: string; text: string }> {
  const socket = connect(server.port, "127.0.0.1");
  await once(socket, "connect");
  const head = Object.entries({
    ...(host === null ? {} : { Host: host }),
    Connection: "close",
    ...extra,
    ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }),
  }).map(([name, value]) => `${name}: ${value}\r\n`);
  socket.write(
    `${method} ${path} HTTP/1.${host === null ? 0 : 1}\r\n${head.join("")}\r\n${body ?? ""}`,
  );
  let response = "";
  // A listener that never answers fails the exchange in seconds, not the test's 30s.
  socket.setTimeout(15_000, () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    response += chunk.toString("utf8");
  });
  await new Promise<void>((resolve) => {
    socket.on("close", resolve);
    socket.on("error", resolve);
  });
  const split = response.indexOf("\r\n\r\n");
  return {
    status: Number(/^HTTP\/1\.[01] (\d{3}) /.exec(response)?.[1]),
    headers: response.slice(0, split).toLowerCase(),
    text: response.slice(split + 4),
  };
}

describe("7. the Host header names this server (DNS rebinding)", () => {
  // A rebinding page is "same-origin" with this socket, so it needs no token to
  // GET and sends no foreign Origin; the Host it sends is its own domain.
  const foreign = (port: number) => [
    "attacker.example",
    `attacker.example:${port}`,
    `127.0.0.1.attacker.example:${port}`,
    `localhost.attacker.example:${port}`,
    `127.0.0.1:${port + 1}`,
    `localhost:${port + 1}`,
    "127.0.0.1",
    "localhost",
    `[::1]:${port}`,
    `127.0.0.1:${port}.attacker.example`,
    "",
  ];

  it("refuses a GET of the API or the page for any other Host, serving neither", async () => {
    for (const host of [...foreign(server.port), null]) {
      for (const path of ["/api/workspace", "/"]) {
        const reply = await rawRequest("GET", path, host);
        const label = `${host} ${path}`;
        expect(reply.status, label).toBe(403);
        expect(reply.headers, label).toContain("x-content-type-options: nosniff");
        expect(zErrorEnvelope.parse(JSON.parse(reply.text)).error.code, label).toBe(
          "console/forbidden",
        );
        // Neither the workspace data nor the page that embeds the token.
        expect(reply.text, label).not.toContain(server.token);
        expect(reply.text, label).not.toContain("payments");
      }
    }
  });

  it("refuses a mutation for any other Host even with the right token and Origin", async () => {
    const auth = {
      Origin: server.url,
      "X-Anvil-Console-Token": server.token,
      "Content-Type": "application/json",
    };
    for (const host of [...foreign(server.port), null]) {
      const reply = await rawRequest("POST", APPROVE, host, auth, JSON.stringify(BODY));
      expect(reply.status, String(host)).toBe(403);
      expect(reply.headers, String(host)).toContain("x-content-type-options: nosniff");
      expect(zErrorEnvelope.parse(JSON.parse(reply.text)).error.code).toBe("console/forbidden");
    }
    // The same request with an accepted Host reaches the handler (a refusal for
    // the unknown id, not the gate's 403), so the 403s above came from the Host.
    const ok = await rawRequest(
      "POST",
      APPROVE,
      `127.0.0.1:${server.port}`,
      auth,
      JSON.stringify(BODY),
    );
    expect(ok.status).toBe(409);
  });

  it("serves 127.0.0.1:<port> and localhost:<port>, whatever the case of the name", async () => {
    for (const host of [
      `127.0.0.1:${server.port}`,
      `localhost:${server.port}`,
      `LOCALHOST:${server.port}`,
    ]) {
      const api = await rawRequest("GET", "/api/workspace", host);
      expect(api.status, host).toBe(200);
      const page = await rawRequest("GET", "/", host);
      expect(page.status, host).toBe(200);
      expect(page.headers, host).toContain("text/html");
    }
  });

  it("answers a request target the URL parser refuses with 400, behind the Host gate", async () => {
    // Node's parser admits these and `new URL` throws on them. That parse sat
    // outside the refusal path, so the throw ended the process, Host gate unrun.
    const host = `127.0.0.1:${server.port}`;
    const auth = {
      Origin: server.url,
      "X-Anvil-Console-Token": server.token,
      "Content-Type": "application/json",
    };
    for (const target of ["//", "http://[", "http://:80/", "//[", "http://a:99999/"]) {
      for (const reply of [
        await rawRequest("GET", target, host),
        await rawRequest("POST", target, host, auth, JSON.stringify(BODY)),
      ]) {
        expect(reply.status, target).toBe(400);
        expect(reply.headers, target).toContain("x-content-type-options: nosniff");
        expect(zErrorEnvelope.parse(JSON.parse(reply.text)).error).toEqual({
          code: "console/invalid_request",
          message: "Malformed request target.",
        });
      }
      // A foreign Host is refused by the gate first, as for any other target.
      const rebound = await rawRequest("GET", target, `attacker.example:${server.port}`);
      expect(rebound.status, target).toBe(403);
    }
    // The access log names no path it could not parse.
    expect(log).toContainEqual(expect.stringMatching(/^GET - 400 \d+ms$/));
    expect((await rawRequest("GET", "/api/workspace", host)).status).toBe(200);
  });
});

describe("8. no page may frame the console (clickjacking)", () => {
  function expectNoFraming(reply: { headers: Headers }, label: string): void {
    expect(reply.headers.get("content-security-policy"), label).toBe("frame-ancestors 'none'");
    expect(reply.headers.get("x-frame-options"), label).toBe("DENY");
  }

  it("forbids framing on the page, built or not, its assets, an API read, and a refusal", async () => {
    const uiDir = join(tmpdir(), `anvil-console-frame-ui-${process.pid}-${Date.now()}`);
    mkdirSync(join(uiDir, "assets"), { recursive: true });
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><html><head></head></html>");
    writeFileSync(join(uiDir, "assets", "app.js"), "console.log('ui');");
    const built = await startServer(ws.root, { uiDir });
    const unbuilt = await startServer(ws.root, { uiDir: join(uiDir, "absent") });
    try {
      for (const [label, reply] of [
        ["built page", await built.client.get("/")],
        ["asset", await built.client.get("/assets/app.js")],
        ["unbuilt page", await unbuilt.client.get("/")],
        ["api read", await client.get("/api/workspace")],
        ["refusal", await client.post(APPROVE, BODY, { token: null })],
      ] as const) {
        expect(reply.status, label).toBe(label === "refusal" ? 403 : 200);
        expectNoFraming(reply, label);
      }
    } finally {
      await built.server.close();
      await unbuilt.server.close();
      rmSync(uiDir, { recursive: true, force: true });
    }
  });
});

describe("the token never leaks", () => {
  it("appears in no /api response and in no log line", async () => {
    const texts: string[] = [];
    for (const key of Object.keys(CONSOLE_ROUTES) as ConsoleRoute[]) {
      const path = CONSOLE_ROUTES[key].path
        .replace(":id", "payments")
        .replace(/:\w+/g, "x")
        .concat(key === "drift" ? "?against=payments" : "");
      const reply = CONSOLE_ROUTES[key].mutates
        ? await client.post(path, {})
        : await client.get(path);
      texts.push(reply.text);
      for (const [name, value] of reply.headers) texts.push(`${name}: ${value}`);
    }
    texts.push((await client.post(APPROVE, BODY, { token: null })).text);
    for (const text of texts) expect(text).not.toContain(server.token);
    expect(log.length).toBeGreaterThan(0);
    for (const line of log) {
      expect(line).not.toContain(server.token);
      expect(line).toMatch(/^(GET|POST|OPTIONS) (\/\S*|-) \d{3} \d+ms$/);
    }
  });
});
