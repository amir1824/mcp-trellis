/**
 * Origin allowlisting — Host-derived Node origins (multi-tenant) and browser
 * `Origin` headers on MCP (DNS rebinding / CSRF). Same predicate shape as
 * redirect allowlisting — not secret comparison.
 */

import { jsonResponse, withReflectedCorsOrigin } from "./http.js";

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

type OriginPredicate = (origin: string, options: OriginAllowlistOptions) => boolean;

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

const ORIGIN_PREDICATES: OriginPredicate[] = [isExactOrigin, isWildcardSubdomain];

/**
 * Host-derived / allowlist Origin check (Node `asNodeHandler` multi-tenant).
 * Empty or omitted `allowedOrigins` → admit all (callers that derive origin
 * from Host must require a non-empty list before reaching here).
 * `"*"` admits any origin.
 */
export const isAllowedOrigin = (origin: string, options: OriginAllowlistOptions = {}): boolean => {
  if (!options.allowedOrigins || options.allowedOrigins.length === 0) {
    return true;
  }
  if (options.allowedOrigins.includes("*")) return true;
  return ORIGIN_PREDICATES.some((predicate) => predicate(origin, options));
};

/**
 * Browser `Origin` on MCP Streamable HTTP (DNS rebinding / CSRF).
 * No header → allow (native / server-to-server). Empty or omitted allowlist →
 * deny any present Origin (secure default — opposite of `isAllowedOrigin`).
 * `"*"` opts out.
 */
export const isAllowedRequestOrigin = (
  originHeader: string | null,
  allowedRequestOrigins?: string[],
): boolean => {
  if (!originHeader) return true;
  if (!allowedRequestOrigins || allowedRequestOrigins.length === 0) return false;
  return isAllowedOrigin(originHeader, { allowedOrigins: allowedRequestOrigins });
};

/** 403 when a present Origin fails the allowlist. `onDenied` runs first (audit). */
export const requestOriginDenied = async (
  request: Request,
  allowedRequestOrigins: string[] | undefined,
  onDenied?: () => Promise<void>,
): Promise<Response | null> => {
  if (isAllowedRequestOrigin(request.headers.get("Origin"), allowedRequestOrigins)) {
    return null;
  }
  await onDenied?.();
  return jsonResponse({ data: { error: "origin not allowed" }, status: 403, cors: false });
};

/** When a non-wildcard allowlist admitted this Origin, reflect it on CORS. */
export const reflectCorsIfNeeded = (
  response: Response,
  request: Request,
  allowedRequestOrigins: string[] | undefined,
): Response => {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedRequestOrigins?.length || allowedRequestOrigins.includes("*")) {
    return response;
  }
  return withReflectedCorsOrigin(response, origin);
};
