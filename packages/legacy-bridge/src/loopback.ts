/**
 * Loopback names, shared by the bind gate (`serveLegacyBridge`) and the
 * facade's Host gate, so the two never disagree about what "loopback" means.
 */

/** `127.0.0.0/8`, `::1`, and the `localhost` name — the interfaces a bridge
 *  binds without an explicit operator decision. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (bare === "localhost" || bare === "::1" || bare === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * Whether a `Host` header names a loopback address on `port`, the port the
 * request reached. A page on `attacker.example` whose DNS has been re-pointed
 * at 127.0.0.1 (DNS rebinding) reaches a loopback socket as its own origin but
 * still sends `Host: attacker.example:<port>`. A Host without a port is on 80.
 */
export function isOwnLoopbackHostHeader(
  hostHeader: string | undefined,
  port: number | undefined,
): boolean {
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::(\d+))?$/.exec(hostHeader ?? "");
  if (!match || (match[2] ?? "80") !== String(port)) return false;
  return isLoopbackHost(match[1] as string);
}
