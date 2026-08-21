/** OAuth scope handling — space-delimited sets (RFC 6749 §3.3). */

import { OAUTH_ERRORS } from "./constants.js";
import { type OAuthErrorInfo, oauthError } from "./types.js";

export const parseScope = (raw: string): string[] =>
  raw
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const formatScope = (scopes: string[]): string => scopes.join(" ");

/**
 * Scopes the client asked for, or `fallback` when `scope` is omitted —
 * `fallback` is the full advertised set only for single-scope servers; see
 * `defaultScopes`/`assertScopeConfig` in `types.ts` for the multi-scope rule.
 * Duplicates are collapsed so the granted string is stable.
 */
export const requestedScopes = (raw: string, fallback: string[]): string[] => {
  const parsed = raw ? parseScope(raw) : [...fallback];
  return [...new Set(parsed)];
};

/**
 * Any scope outside the advertised set → invalid_scope. Info-only variant
 * — see `resource.ts`'s `resourceErrorInfo` for why this isn't a
 * `Response` directly: `/authorize` needs to redirect this, not return it.
 */
export const scopeErrorInfo = (
  requested: string[],
  advertised: string[],
): OAuthErrorInfo | null => {
  const unknown = requested.find((scope) => !advertised.includes(scope));
  return unknown === undefined
    ? null
    : { code: OAUTH_ERRORS.invalidScope, description: `unsupported scope: ${unknown}` };
};

/** Any scope outside the advertised set → invalid_scope. */
export const firstScopeError = (requested: string[], advertised: string[]): Response | null => {
  const issue = scopeErrorInfo(requested, advertised);
  return issue ? oauthError(issue.code, 400, issue.description) : null;
};
