/**
 * Keeping a credential written into a URL out of what an importer emits. Userinfo
 * (`user:pass@`) is a credential, and malformed spellings decide where a parser thinks
 * it is: browsers and Node's URL read `https:/u:p@host` and `https:\\u:p@host` as
 * userinfo, while a pattern keyed on "//" sees none. So these helpers rest on two facts
 * rather than on guessing: userinfo needs an "@" before the query, and a parsed URL's
 * scheme, host, path and query never include it. What can't be shown free of userinfo
 * is refused (undefined), and the caller falls back to a placeholder.
 */

/** Any run of "/" or "\" after an http(s) scheme is "//" to browsers and Node's URL. */
export function normalizeSchemeSlashes(text: string): string {
  return text.replace(/^(\s*https?:)[\\/]*/i, "$1//");
}

/** The text before the query, or undefined when it has an "@" and so may carry userinfo. */
export function headWithoutUserinfo(text: string): string | undefined {
  const head = text.split(/[?#]/)[0] ?? "";
  return head.includes("@") ? undefined : head;
}

/**
 * A server base (scheme, host, port, perhaps a base path) without its userinfo, which
 * runs to the last "@" before the first "/", "?" or "#". An "@" after that is left
 * alone, so it can never move the host; one left before the query refuses the base.
 */
export function baseWithoutUserinfo(base: string): string | undefined {
  const stripped = normalizeSchemeSlashes(base).replace(/^((?:[^/?#]*:)?\/\/)?[^/?#]*@/, "$1");
  return headWithoutUserinfo(stripped) === undefined ? undefined : stripped;
}

/**
 * A URL without its userinfo and with only the query parameters `keepQuery` accepts.
 * A URL the parser accepts is rebuilt from its scheme, host, path and kept query when
 * anything has to go; one it rejects (a `{{base}}/token` template) keeps only what
 * precedes its query. Either way, an "@" left before the query refuses the URL.
 */
export function urlWithoutUserinfo(
  raw: string | undefined,
  keepQuery: (name: string) => boolean = () => true,
): string | undefined {
  if (raw === undefined) return undefined;
  const head = headWithoutUserinfo(raw);
  if (!URL.canParse(raw)) return head;
  const url = new URL(raw);
  const kept = [...url.searchParams].filter(([name]) => keepQuery(name));
  if (head !== undefined && kept.length === url.searchParams.size) return raw;
  if (url.pathname.includes("@")) return undefined;
  const query = new URLSearchParams(kept).toString();
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ""}`;
}
