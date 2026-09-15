/** OAuth construction asserts and small response helpers. */

import { jsonResponse } from "../http/http.js";
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
 *
 * This controls only what a *token* is granted at authorize time —
 * `defaultScopes: []` still leaves any tool that omits `ToolDef.scope`
 * callable by a principal holding zero scopes, since that check happens
 * per tool-call, not here. `createMcpApp` has the matching guard on the
 * tool side: it refuses to construct with an unscoped tool once `scopes`
 * has more than one entry (`assertToolScopesConfigured` in `app.ts`).
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
 * Copy-paste from this package's docs is the realistic failure mode: every
 * published example secret is either under the length floor or carries
 * the marker below (enforced by test/oauth/crypto/codesecret.test.ts).
 */
const MIN_CODE_SECRET_LENGTH = 32;
const DENYLISTED_CODE_SECRET_MARKER = "do-not-reuse";
const GENERATE_HINT = "generate one with `openssl rand -base64 32`";

export const assertCodeSecret = (secret: string): void => {
  // Checked before the length rule so a copied example is named for what it is.
  if (secret.includes(DENYLISTED_CODE_SECRET_MARKER)) {
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

/**
 * Resolves `codeSecret` to a non-empty key list — a single string becomes a
 * one-element array. The **first** entry is the one every caller here uses
 * to seal new material or hash new client secrets; the full array is what a
 * caller trying to unseal/verify existing material tries in order (see
 * `unsealAny`, `verifyClientSecretAny`). Every entry is validated the same
 * way a lone string always was.
 */
export const resolveSecrets = async (
  ports: OAuthPorts,
  request: Request,
): Promise<readonly [string, ...string[]]> => {
  const resolved =
    typeof ports.codeSecret === "function" ? await ports.codeSecret(request) : ports.codeSecret;
  const secrets = Array.isArray(resolved) ? resolved : [resolved];
  if (secrets.length === 0) {
    throw new Error("codeSecret must resolve to at least one key, not an empty array");
  }
  secrets.forEach(assertCodeSecret);
  // Cast is sound: the length check above guarantees at least one element.
  return secrets as [string, ...string[]];
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

/**
 * `grantedScope` is what the auth code carried (or a narrowed refresh
 * request); the port may narrow it further. With neither, `scope` is
 * omitted (optional when unchanged, RFC 6749 §5.1) rather than guessed.
 */
export const tokenResponse = (minted: MintedToken, grantedScope?: string): Response => {
  const scope = minted.scope ?? grantedScope;
  return jsonResponse({
    data: {
      access_token: minted.accessToken,
      token_type: minted.tokenType ?? "bearer",
      expires_in: minted.expiresIn,
      ...(scope !== undefined ? { scope } : {}),
      ...(minted.refreshToken ? { refresh_token: minted.refreshToken } : {}),
    },
    status: 200,
    cors: false,
  });
};
