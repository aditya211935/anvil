/**
 * Whether an OAuth endpoint may be handed a grant: HTTPS, or plain HTTP to the
 * exact `127.0.0.1` literal, which never leaves the host. A token endpoint
 * receives a refresh token or authorization code with the client secret; an
 * authorization endpoint is where a person signs in. One rule for both, for the
 * env-only refresh resolver (auth.ts), the vault's refresh (vault.ts), and the
 * connect flow (connect.ts), whether the endpoint came from AIR or an override.
 *
 * The loopback exception is not dev-gated like `safe-http.ts`'s: none of these
 * callers sees the runtime's dev/prod setting. No public-address check either:
 * an operator's internal IdP is a legitimate endpoint here.
 */
export function isSendableOAuthEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1");
}
