/**
 * What stands between a malformed request and the process, for the HTTP
 * servers Anvil ships.
 *
 * Node's HTTP parser accepts request targets the WHATWG URL parser refuses —
 * `GET //`, `GET http://[`, `GET http://:80/` — so `new URL(req.url, base)`
 * throws on bytes any client can send. Inside an async `createServer` listener
 * that throw is a rejected promise nobody awaits, and an unhandled rejection
 * ends the process: one `curl http://host//` stopped the server, ahead of the
 * inbound-auth check on every route that has one. `parseRequestTarget` turns
 * the target into a value the listener answers 400; `createGuardedServer`
 * answers anything else a listener fails to catch (a 500, or a destroyed socket
 * once a response has started) rather than letting it reach the process.
 *
 * Shared by `runtime/server.js` (serve.ts), the generated `mcp/server-sse.js`,
 * and the CLI's fleet listener.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** The 400 body for a request target the URL parser refuses. */
export const MALFORMED_TARGET = {
  error: { code: "bad_request", message: "Malformed request target." },
} as const;

const INTERNAL_ERROR = {
  error: { code: "internal_error", message: "The request could not be handled." },
} as const;

/** The request target as a URL, or `undefined` for one the URL parser refuses. */
export function parseRequestTarget(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", "http://localhost");
  } catch {
    return undefined;
  }
}

/**
 * `createServer` for an async listener, so a listener that rejects (or throws)
 * is answered instead of crashing the process. Before a response has started
 * the caller gets a generic 500 — never the error's text, which can carry a
 * path or a provider's state — and after, the socket is destroyed so a
 * half-written response is not mistaken for a whole one. `report` hears every
 * such failure; it defaults to one fixed line on stderr.
 */
export function createGuardedServer(
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
  report: (error: unknown) => void = () => console.error("HTTP request handling failed."),
): Server {
  return createServer((req, res) => {
    new Promise((resolve) => resolve(listener(req, res))).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500, {
          "content-type": "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify(INTERNAL_ERROR));
      }
      try {
        report(error);
      } catch {
        // A failing reporter must not become the unhandled rejection this guards against.
      }
    });
  });
}
