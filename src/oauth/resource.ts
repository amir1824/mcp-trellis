/** Canonical MCP resource URI (RFC 8707 / RFC 9728). */

import { OAUTH_ERRORS } from "./constants.js";
import { type OAuthErrorInfo, oauthError } from "./types.js";

export const DEFAULT_RESOURCE_PATH = "/mcp";

/**
 * Strips a trailing slash from a *configured* path (`resourcePath`,
 * `oauthPath`) so `"/mcp/"` and `"/mcp"` can't produce divergent canonical
 * resources — `canonicalResource` doesn't strip one itself, but
 * `normalizeResource` (used to compare an incoming request's resource
 * against it) does, so leaving a trailing slash in the *configured* value
 * silently made every request fail to match. `"/"` stays `"/"`. Apply once
 * at construction, not per request.
 */
export const normalizeConfiguredPath = (path: string): string =>
  path === "/" ? path : path.replace(/\/+$/, "") || "/";

/**
 * Normalizes `resourcePath` internally (trailing slash stripped) so every
 * caller gets a consistent result regardless of whether it read a raw
 * `options.resourcePath` or a value some other layer already normalized —
 * `"/mcp/"` and `"/mcp"` must produce the same canonical resource, since
 * `resourcesEqual` compares against a normalized incoming request either
 * way (see `normalizeResource` below). Centralizing the fix here, instead
 * of only in the callers that happen to normalize their own config,
 * removes an entire class of "which of these read the normalized value"
 * bugs at the source.
 */
export const canonicalResource = (origin: string, resourcePath = DEFAULT_RESOURCE_PATH): string => {
  const base = origin.replace(/\/$/, "");
  const withLeadingSlash = resourcePath.startsWith("/") ? resourcePath : `/${resourcePath}`;
  return `${base}${normalizeConfiguredPath(withLeadingSlash)}`;
};

/**
 * Normalize for RFC 8707 comparison.
 * Rejects fragments (MUST NOT). Includes query so tenants cannot alias.
 * ponytail: exact match after WHATWG URL parse; upgrade to RFC 3986 if
 * non-ASCII hosts or exotic percent-encoding show up.
 */
const normalizeResource = (uri: string): string | null => {
  try {
    const u = new URL(uri);
    if (u.hash) return null;
    const path = u.pathname.replace(/\/$/, "") || "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
};

export const resourcesEqual = (requested: string, expected: string): boolean => {
  const a = normalizeResource(requested);
  return a !== null && a === normalizeResource(expected);
};

/**
 * Missing → invalid_request; mismatch → invalid_target. Info-only variant
 * (no `Response` built) so a caller can choose how to deliver it —
 * `/token` returns it directly as JSON via `firstResourceError` below;
 * `/authorize` redirects it to the client's callback per RFC 6749 §4.1.2.1
 * once `redirect_uri` itself is trusted (see `authorize.ts`).
 */
export const resourceErrorInfo = (requested: string, expected: string): OAuthErrorInfo | null => {
  if (!requested) {
    return { code: OAUTH_ERRORS.invalidRequest, description: "resource required (RFC 8707)" };
  }
  if (!resourcesEqual(requested, expected)) {
    return { code: OAUTH_ERRORS.invalidTarget, description: "resource does not match this server" };
  }
  return null;
};

/** Missing → invalid_request; mismatch → invalid_target. */
export const firstResourceError = (requested: string, expected: string): Response | null => {
  const issue = resourceErrorInfo(requested, expected);
  return issue ? oauthError(issue.code, 400, issue.description) : null;
};
