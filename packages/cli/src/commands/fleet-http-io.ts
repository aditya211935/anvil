import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

/** Small JSON-over-HTTP helpers the fleet listeners share. */

/** True for the loopback names/addresses a local fleet is meant to bind. */
export function isLoopbackHost(host: string): boolean {
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

/**
 * Whether a `Host` header names a loopback address on the port the request
 * reached. A browser reaches a listener under whatever name its page was
 * loaded from, so a page on `attacker.example` whose DNS has been re-pointed at
 * 127.0.0.1 (DNS rebinding) sends `Host: attacker.example:<port>`. A client that
 * omits the port is on port 80.
 */
export function isOwnLoopbackHost(
  hostHeader: string | undefined,
  localPort: number | undefined,
): boolean {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(hostHeader ?? "");
  if (!match || (match[2] ?? "80") !== String(localPort)) return false;
  const name = (match[1] as string).toLowerCase();
  if (!name.startsWith("[")) return isLoopbackHost(name);
  const inner = name.slice(1, -1);
  return isIP(inner) === 6 && isLoopbackHost(inner);
}

/**
 * Whether an `Origin` header is the listener's own loopback origin: plain
 * `http://` and a host `isOwnLoopbackHost` accepts. A page served from any other
 * origin, including another local port, does not match.
 */
export function isOwnLoopbackOrigin(origin: string, localPort: number | undefined): boolean {
  const match = /^http:\/\/([^/]+)$/.exec(origin);
  return match !== null && isOwnLoopbackHost(match[1], localPort);
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

const CONNECT_BODY_MAX_BYTES = 64 * 1024;

export function readSmallJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Record<string, unknown> | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > CONNECT_BODY_MAX_BYTES) {
        req.resume();
        return finish(undefined);
      }
      chunks.push(bytes);
    });
    req.once("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        finish(
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined,
        );
      } catch {
        finish(undefined);
      }
    });
    req.once("error", () => finish(undefined));
  });
}
