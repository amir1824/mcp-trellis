/** Cache hints for 2026-07-28 results. `private` unless a result is served to anyone without authentication. */

export type CacheScope = "public" | "private";

export type CacheHints = { ttlMs: number; cacheScope: CacheScope };

/** Immediately stale: a hint that is always safe, with no option to tune until a use case asks for one. */
const STALE_TTL_MS = 0;

/** Results that carry hints and are served only after authentication or a scope check. */
const AUTHENTICATED_HINTED_METHODS: ReadonlySet<string> = new Set([
  "tools/list",
  "resources/list",
  "resources/read",
  "skills/list",
  "skills/get",
]);

export const authenticatedHints = (method: string): CacheHints | undefined =>
  AUTHENTICATED_HINTED_METHODS.has(method)
    ? { ttlMs: STALE_TTL_MS, cacheScope: "private" }
    : undefined;

/** `public` only when the request carried no principal at all. */
export const discoverHints = (anonymous: boolean): CacheHints => ({
  ttlMs: STALE_TTL_MS,
  cacheScope: anonymous ? "public" : "private",
});
