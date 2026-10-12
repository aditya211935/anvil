/**
 * The DNS-rebinding gate for an HTTP server running with inbound auth off.
 *
 * Without a bearer token to check, reaching the socket is the only gate, and a
 * web page walks around it: it re-points its own domain at this machine (at
 * 127.0.0.1, or at its LAN address) and calls the server as its own origin
 * (GHSA-w48q-cv73-mx4w is this class against the MCP SDK's own HTTP helper).
 * Two checks run before any route:
 *
 * - `Origin`, on every connection. A browser names the calling page in it on
 *   every non-GET request and every cross-origin CORS-mode GET, so a present
 *   `Origin` must be this server's own loopback origin: `http://` a loopback
 *   name on the port the connection arrived on. Neither server sends CORS
 *   headers, so no page on another origin could read a reply or send a JSON
 *   POST unless a proxy in front answered CORS for it; such a proxy should drop
 *   `Origin` after its own check, or the server should use inbound auth.
 * - `Host`, on a connection that arrived on a loopback address. The browser
 *   still names the rebound domain there, so `Host` must name a loopback
 *   address (any port: only a forwarder renames the port, and a page can never
 *   send a loopback name). A connection on any other address (Cloud Run, a
 *   Kubernetes Service, `docker run -p`) reached the network interface and
 *   keeps whatever `Host` its platform sends.
 *
 * A `Host` listed in `ANVIL_INBOUND_ALLOWED_HOSTS` (typically a reverse proxy
 * that keeps the public name) is served on any connection, with no `Origin` or
 * that host's own.
 * Nothing is checked under Knative or Cloud Run (`K_SERVICE`), whose
 * queue-proxy delivers every request to 127.0.0.1 with the public `Host`.
 *
 * What stays open: a same-origin GET carries no `Origin`, so a page whose
 * request arrives off the loopback (rebound to the machine's network address,
 * or to 127.0.0.1 in front of `docker run -p`) can still read GET routes such
 * as `/openapi` and `/healthz` and open server-sse.js's `GET /sse` stream. None
 * returns credentials or calls a tool (`POST /messages` carries `Origin` and is
 * refused). Inbound auth closes that.
 *
 * Shared by `runtime/server.js` (serve.ts) and the generated `mcp/server-sse.js`.
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { isIP } from "node:net";
import type { InboundAuthMode } from "./inbound-auth.js";

/** Whether a socket's local address is loopback: 127.0.0.0/8, ::1, or IPv4-mapped 127.x. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const ip = address?.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (!ip) return false;
  if (isIP(ip) === 4) return ip.startsWith("127.");
  return ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

/**
 * Whether `authority` (a `Host` value, or an origin's host[:port]) names a
 * loopback address — `localhost`, 127.x, `[::1]` — on `port` (no port is 80),
 * or on any port when `port` is null.
 */
function isOwnLoopbackAuthority(authority: string, port: number | undefined | null): boolean {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(authority);
  if (!match || (port !== null && (match[2] ?? "80") !== String(port))) return false;
  const name = (match[1] as string).toLowerCase();
  if (name === "localhost") return true;
  if (name.startsWith("[")) return isLoopbackAddress(name.slice(1, -1));
  return isIP(name) === 4 && name.startsWith("127.");
}

/** Why `origin` is refused: present, and not `http://` a loopback name on `port`. */
function originRefusal(
  origin: string | undefined,
  port: number | undefined,
): "origin_not_allowed" | undefined {
  if (origin === undefined) return undefined;
  const authority = /^http:\/\/([^/]+)$/i.exec(origin)?.[1];
  return authority && isOwnLoopbackAuthority(authority, port) ? undefined : "origin_not_allowed";
}

/** The `ANVIL_INBOUND_ALLOWED_HOSTS` entry `host` matches exactly, lowercased, or undefined. */
function allowedInboundHost(host: string | undefined, env: NodeJS.ProcessEnv): string | undefined {
  const name = host?.toLowerCase();
  const entries = env.ANVIL_INBOUND_ALLOWED_HOSTS?.split(",") ?? [];
  return name && entries.some((entry) => entry.trim().toLowerCase() === name) ? name : undefined;
}

/**
 * Why a request is refused, or undefined when it may be served: a present
 * `Origin` that is not this server's own loopback origin (any connection), or a
 * `Host` that names no loopback address (a loopback connection). A `Host` in
 * `ANVIL_INBOUND_ALLOWED_HOSTS` is served when any `Origin` is that host's.
 */
export function loopbackRequestRefusal(
  req: IncomingMessage,
  env: NodeJS.ProcessEnv = process.env,
): "host_not_allowed" | "origin_not_allowed" | undefined {
  // Knative (whose contract Cloud Run follows, both setting K_SERVICE) proxies every
  // request from its queue-proxy to 127.0.0.1 with the public Host; no browser is there.
  if (env.K_SERVICE) return undefined;
  const { localAddress, localPort } = req.socket;
  const origin = req.headers.origin;
  const named = allowedInboundHost(req.headers.host, env);
  if (named) {
    const own = origin?.toLowerCase();
    return own === undefined || own === `http://${named}` || own === `https://${named}`
      ? undefined
      : "origin_not_allowed";
  }
  // Off the loopback, the platform chose Host; a page rebound to a LAN address
  // still names itself in Origin on every request that can call a tool.
  if (!isLoopbackAddress(localAddress)) return originRefusal(origin, localPort);
  if (!isOwnLoopbackAuthority(req.headers.host ?? "", null)) return "host_not_allowed";
  return originRefusal(origin, localPort);
}

const REFUSAL_MESSAGE = {
  host_not_allowed:
    "Without inbound auth this server answers a loopback connection only when Host names a loopback address or a host in ANVIL_INBOUND_ALLOWED_HOSTS. Set ANVIL_INBOUND_ALLOWED_HOSTS to name a reverse proxy's host, or ANVIL_INBOUND_AUTH_MODE to serve any name.",
  origin_not_allowed:
    "Without inbound auth this server answers a browser request only from its own loopback origin, or from the origin of a host in ANVIL_INBOUND_ALLOWED_HOSTS. Set ANVIL_INBOUND_AUTH_MODE to serve other origins.",
} as const;

/**
 * Answer `403` to a request {@link loopbackRequestRefusal} refuses, before any
 * route runs. Returns whether it answered. Call it only with inbound auth off.
 */
export function refuseRebindingRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const code = loopbackRequestRefusal(req);
  if (!code) return false;
  req.resume();
  res.writeHead(403, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify({ error: { code, message: REFUSAL_MESSAGE[code] } }));
  return true;
}

/**
 * The one startup line for a server with inbound auth off that listens on every
 * interface outside Cloud Run (`K_SERVICE`) and Kubernetes
 * (`KUBERNETES_SERVICE_HOST`), where the platform decides what reaches it.
 */
export function openListenerWarning(
  mode: InboundAuthMode,
  address: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (mode !== "none" || (address !== "::" && address !== "0.0.0.0")) return undefined;
  if (env.K_SERVICE || env.KUBERNETES_SERVICE_HOST) return undefined;
  return (
    "anvil runtime: inbound auth is off and the server listens on every interface, so anything " +
    "that can reach this port can call its tools; set ANVIL_INBOUND_AUTH_MODE before it shares a " +
    "network you do not trust."
  );
}

/** Print {@link openListenerWarning} to stderr once `server` is listening. */
export function warnWhenOpenWithoutAuth(server: Server, mode: InboundAuthMode): void {
  server.once("listening", () => {
    const address = server.address();
    const line = openListenerWarning(
      mode,
      typeof address === "object" && address ? address.address : undefined,
    );
    if (line) console.error(line);
  });
}
