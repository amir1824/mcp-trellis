/** OAuth scope handling — space-delimited sets (RFC 6749 §3.3). */

import { OAUTH_ERRORS } from "./constants.js";
import { oauthError } from "./types.js";

export const parseScope = (raw: string): string[] =>
  raw
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatScope = (scopes: string[]): string => scopes.join(" ");

/**
 * Scopes the client asked for, or the full advertised set when `scope` is omitted.
 * Duplicates are collapsed so the granted string is stable.
 */
export const requestedScopes = (
  raw: string,
  advertised: string[],
): string[] => {
  const parsed = raw ? parseScope(raw) : [...advertised];
  return [...new Set(parsed)];
};

/** Any scope outside the advertised set → invalid_scope. */
export const firstScopeError = (
  requested: string[],
  advertised: string[],
): Response | null => {
  const unknown = requested.find((scope) => !advertised.includes(scope));
  if (unknown === undefined) return null;
  return oauthError(
    OAUTH_ERRORS.invalidScope,
    400,
    `unsupported scope: ${unknown}`,
  );
};
