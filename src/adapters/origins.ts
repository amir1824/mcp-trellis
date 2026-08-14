/**
 * Origin allowlist for Host-derived Node origins (multi-tenant SaaS).
 * Same predicate shape as redirect allowlisting — not secret comparison.
 */

export type OriginAllowlistOptions = {
  /**
   * Exact origins (`https://acme.example.com`) and/or `*.example.com`
   * wildcards. Wildcards match https subdomains only (not the apex, not http).
   * `"*"` admits any origin (loud opt-out).
   *
   * Empty/omitted list → admit all (only safe with a fixed `asNodeHandler`
   * `origin`). Host-derived `asNodeHandler` requires a non-empty list at
   * construction. Resolved origin outside the list → 400; a fixed `origin`
   * absent from a non-empty list throws at construction.
   */
  allowedOrigins?: string[];
};

type OriginPredicate = (
  origin: string,
  options: OriginAllowlistOptions,
) => boolean;

const originOf = (value: string): string | null => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const isExactOrigin: OriginPredicate = (origin, options) => {
  const normalized = originOf(origin);
  if (!normalized) return false;
  return Boolean(
    options.allowedOrigins?.some((entry) => {
      if (entry.startsWith("*.")) return false;
      return originOf(entry) === normalized;
    }),
  );
};

/** `*.example.com` matches `https://acme.example.com`, not the apex, not http. */
const isWildcardSubdomain: OriginPredicate = (origin, options) => {
  const patterns = options.allowedOrigins ?? [];
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "https:") return false;
    return patterns.some((entry) => {
      if (!entry.startsWith("*.")) return false;
      const suffix = entry.slice(1); // ".example.com"
      return hostname.endsWith(suffix) && hostname.length > suffix.length;
    });
  } catch {
    return false;
  }
};

const ORIGIN_PREDICATES: OriginPredicate[] = [
  isExactOrigin,
  isWildcardSubdomain,
];

export const isAllowedOrigin = (
  origin: string,
  options: OriginAllowlistOptions = {},
): boolean => {
  // Empty/omitted: admit all — callers that derive origin from Host must
  // require a non-empty list before reaching here (see asNodeHandler).
  if (!options.allowedOrigins || options.allowedOrigins.length === 0) {
    return true;
  }
  if (options.allowedOrigins.includes("*")) return true;
  return ORIGIN_PREDICATES.some((predicate) => predicate(origin, options));
};
