/** OAuth construction asserts and small response helpers. */

import { jsonResponse } from "../http.js";
import { DEFAULT_SCOPE } from "./constants.js";
import type { MintedToken, OAuthPorts, OAuthRouterOptions } from "./types.js";

/** Default true — see `OAuthRouterOptions.allowUnregisteredClients`. */
export const unregisteredClientsAllowed = (options: OAuthRouterOptions): boolean =>
  options.allowUnregisteredClients !== false;

/** Default true since 1.0 — see `OAuthRouterOptions.requireRegisteredClients`. */
export const registeredClientsRequired = (options: OAuthRouterOptions): boolean =>
  options.requireRegisteredClients !== false;

/** Scopes this AS advertises and is willing to grant. */
export const advertisedScopes = (options: OAuthRouterOptions): string[] =>
  options.scopes ?? [DEFAULT_SCOPE];

/**
 * Scopes granted when a client omits `scope`. Falls back to the full
 * advertised set only when that set has at most one entry — see
 * `assertScopeConfig`, which forbids the ambiguous multi-scope case at
 * construction instead of silently over-granting here.
 */
export const defaultScopes = (options: OAuthRouterOptions): string[] =>
  options.defaultScopes ?? advertisedScopes(options);

/**
 * A multi-scope server MUST say what an omitted `scope` grants — the
 * alternative (silently granting everything advertised) is exactly the
 * escalation least-privilege scoping exists to prevent.
 */
export const assertScopeConfig = (options: OAuthRouterOptions): void => {
  const advertised = advertisedScopes(options);
  if (advertised.length > 1 && !options.defaultScopes) {
    throw new Error(
      "scopes has more than one entry — defaultScopes must say what an omitted " +
        "scope request grants (e.g. defaultScopes: [] for least privilege)",
    );
  }
  const unknown = (options.defaultScopes ?? []).find((scope) => !advertised.includes(scope));
  if (unknown !== undefined) {
    throw new Error(`defaultScopes contains "${unknown}", which is not in scopes`);
  }
};

/**
 * `codeSecret` can forge an auth code for any userId/scope/resource, so a
 * weak or copy-pasted one is a full authorization bypass, not a footgun.
 * The literals here are the exact strings this package's own docs/examples
 * publish — copy-paste is the realistic failure mode.
 */
const MIN_CODE_SECRET_LENGTH = 32;
const DENYLISTED_CODE_SECRETS = new Set([
  "e2e-code-secret-value",
  "change-me",
  "test-secret-value",
]);
const GENERATE_HINT = "generate one with `openssl rand -base64 32`";

export const assertCodeSecret = (secret: string): void => {
  // Checked before the length rule so a denylisted literal is always named
  // for what it is, even if a future literal happens to be 32+ characters.
  if (DENYLISTED_CODE_SECRETS.has(secret)) {
    throw new Error(
      `codeSecret must not be a literal published in this package's own docs or examples — ${GENERATE_HINT}`,
    );
  }
  if (secret.length < MIN_CODE_SECRET_LENGTH) {
    throw new Error(
      `codeSecret must be at least ${MIN_CODE_SECRET_LENGTH} characters (got ${secret.length}) — ${GENERATE_HINT}`,
    );
  }
};

export const resolveSecret = async (ports: OAuthPorts, request: Request): Promise<string> => {
  const secret =
    typeof ports.codeSecret === "string" ? ports.codeSecret : await ports.codeSecret(request);
  assertCodeSecret(secret);
  return secret;
};

export const oauthError = (error: string, status: number, description?: string): Response =>
  jsonResponse({
    data: description ? { error, error_description: description } : { error },
    status,
    cors: false,
  });

const UNREGISTERED_CLIENT_DESCRIPTION =
  "unknown client_id — this server only serves pre-registered clients";

/** Direct JSON error when this AS does not serve unknown `client_id`s. */
export const unregisteredClientError = (
  options: OAuthRouterOptions,
  reject: { code: string; status: number },
): Response | null => {
  if (unregisteredClientsAllowed(options)) return null;
  return oauthError(reject.code, reject.status, UNREGISTERED_CLIENT_DESCRIPTION);
};

/** `grantedScope` is what the auth code carried; the port may narrow it further. */
export const tokenResponse = (minted: MintedToken, grantedScope?: string): Response =>
  jsonResponse({
    data: {
      access_token: minted.accessToken,
      token_type: minted.tokenType ?? "bearer",
      expires_in: minted.expiresIn,
      scope: minted.scope ?? grantedScope ?? DEFAULT_SCOPE,
      ...(minted.refreshToken ? { refresh_token: minted.refreshToken } : {}),
    },
    status: 200,
    cors: false,
  });
