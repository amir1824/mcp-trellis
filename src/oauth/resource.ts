/** Canonical MCP resource URI (RFC 8707 / RFC 9728). */

import { OAUTH_ERRORS } from "./constants.js";
import { oauthError } from "./types.js";

export const DEFAULT_RESOURCE_PATH = "/mcp";

export const canonicalResource = (
  origin: string,
  resourcePath = DEFAULT_RESOURCE_PATH,
): string => {
  const base = origin.replace(/\/$/, "");
  const path = resourcePath.startsWith("/")
    ? resourcePath
    : `/${resourcePath}`;
  return `${base}${path}`;
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

export const resourcesEqual = (
  requested: string,
  expected: string,
): boolean => {
  const a = normalizeResource(requested);
  return a !== null && a === normalizeResource(expected);
};

/** Missing → invalid_request; mismatch → invalid_target. */
export const firstResourceError = (
  requested: string,
  expected: string,
): Response | null => {
  if (!requested) {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      400,
      "resource required (RFC 8707)",
    );
  }
  if (!resourcesEqual(requested, expected)) {
    return oauthError(
      OAUTH_ERRORS.invalidTarget,
      400,
      "resource does not match this server",
    );
  }
  return null;
};
