import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { mcpProbe } from "./mcp-probe.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

describe("mcpProbe over streamable HTTP", () => {
  it("names a cross-origin redirect it did not follow, without echoing the URL or sending the headers on", async () => {
    const reached: Array<string | undefined> = [];
    const elsewhere = await serve((req, res) => {
      reached.push(req.headers.authorization);
      res.writeHead(500);
      res.end();
    });
    const endpointPort = await serve((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${elsewhere}/mcp?token=moved` });
      res.end();
    });
    const endpoint = `http://127.0.0.1:${endpointPort}/mcp?token=secret-in-query`;

    const result = await mcpProbe({
      headers: { authorization: "Bearer probe-secret" },
      timeoutMs: 5_000,
    }).capture(endpoint);

    expect(result).toEqual({
      ok: false,
      code: "unreachable",
      message:
        "the MCP endpoint answered HTTP 307 with a redirect, which is not followed (only a 307 or 308 within the same origin is); pass the final (post-redirect) URL as the endpoint",
    });
    expect(reached).toEqual([]);
  });

  it("keeps the generic message for an endpoint that is simply down", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(502);
      res.end();
    });
    const result = await mcpProbe({ timeoutMs: 5_000 }).capture(`http://127.0.0.1:${port}/mcp`);
    expect(result).toEqual({
      ok: false,
      code: "unreachable",
      message: "the MCP endpoint could not be reached or refused the handshake",
    });
  });
});
