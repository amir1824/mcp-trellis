/** Token-endpoint client authentication (RFC 6749 §2.3.1). */

import { safeOAuthAudit } from "./audit.js";
import { isCimdClientId } from "./cimd.js";
import {
  oauthError,
  registeredClientsRequired,
  resolveSecrets,
  unregisteredClientsAllowed,
} from "./config.js";
import {
  OAUTH_ERRORS,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "./constants.js";
import { unsealAny } from "./sealed.js";
import { verifyClientSecretAny } from "./secrethash.js";
import type { ClientAssertion, OAuthRouterOptions } from "./types.js";

export type ClientAuth = {
  clientId: string;
  secret: string | null;
  method: TokenEndpointAuthMethod;
};

/** `Authorization: Basic base64(urlencode(id):urlencode(secret))`. */
const parseBasicAuth = (header: string | null): ClientAuth | null => {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    const clientId = decodeURIComponent(decoded.slice(0, separator));
    if (!clientId) return null;
    return {
      clientId,
      secret: decodeURIComponent(decoded.slice(separator + 1)),
      method: TOKEN_ENDPOINT_AUTH_METHODS.basic,
    };
  } catch {
    return null;
  }
};

/** Credentials from the Authorization header, else from the body. */
export const readClientAuth = (
  request: Request,
  body: Record<string, string>,
): ClientAuth | null => {
  const basic = parseBasicAuth(request.headers.get("Authorization"));
  if (basic) return basic;

  const clientId = body.client_id ?? "";
  if (!clientId) return null;

  const secret = body.client_secret ?? "";
  return {
    clientId,
    secret: secret.length > 0 ? secret : null,
    method: secret.length > 0 ? TOKEN_ENDPOINT_AUTH_METHODS.post : TOKEN_ENDPOINT_AUTH_METHODS.none,
  };
};

/**
 * Every failure below returns the same code, status, and description.
 * Distinguishable messages here ("client requires client_secret_basic" vs.
 * "unknown client_id" vs. "client_secret required" vs. …) let an
 * unauthenticated caller enumerate which client_ids this server actually
 * knows about and how each is configured, just by reading error text —
 * a real information leak on the one endpoint whose entire job is to
 * reject an untrusted caller. `/authorize`'s `unauthorized_client` stays
 * descriptive on purpose: it's a human debugging an OAuth flow in a
 * browser, not a bare API response, and a locked-down server already
 * announces the same fact by omitting `registration_endpoint` from its
 * metadata.
 */
const CLIENT_AUTH_FAILED = "client authentication failed";

/** The generic response every failure below returns to the caller. */
const invalidClient = (): Response =>
  oauthError(OAUTH_ERRORS.invalidClient, 401, CLIENT_AUTH_FAILED);

/** The response above, plus the real reason to `ports.audit` — never to the caller. */
const invalidClientAudited = async (
  options: OAuthRouterOptions,
  clientId: string,
  reason: string,
): Promise<Response> => {
  await safeOAuthAudit(options, { event: "client_auth_failed", clientId, reason });
  return invalidClient();
};

/**
 * Never a real credential — exists only so the locked-down branch below
 * does the same amount of comparison work whether or not a secret was
 * actually presented, and whether or not a stored hash actually exists.
 */
const DUMMY_SECRET = "dummy-secret-for-constant-time-padding";
const DUMMY_STORED_HASH = "hmac-sha256$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Enforce the registered auth method for known clients.
 *
 * An unknown client_id is treated as public — PKCE is its only proof —
 * unless `allowUnregisteredClients` is false, in which case it is rejected
 * rather than silently falling back to "no auth required". On that
 * locked-down path, a dummy secret comparison runs even for a client_id
 * this server has never heard of, so the crypto-verification cost can't be
 * used to distinguish "unknown" from "known, wrong secret" by timing. This
 * only runs on the non-default, already-more-expensive path — public
 * clients (the common case) never pay it.
 *
 * A client_id resolved by neither `clientStore` nor unsealing as this
 * server's own `/register` assertion is further rejected when
 * `requireRegisteredClients` (default true since 1.0) applies — the same
 * rule `authorize.ts` already enforces. Without this, an invented public
 * `client_id` that never went through `/authorize` at all could still
 * authenticate at `/token`'s `refresh_token` grant or at `/revoke`, quietly
 * bypassing the guarantee `requireRegisteredClients`'s own docs describe as
 * global. The `authorization_code` grant was never actually exposed by this
 * gap — a redeemable code's `clientId` is bound into its sealed payload at
 * `/authorize` time, where this same check already ran — but `/token` and
 * `/revoke` share this one gate for every grant, so the fix belongs here,
 * not duplicated per grant type.
 */
export const firstClientAuthError = async (
  auth: ClientAuth,
  options: OAuthRouterOptions,
  request: Request,
): Promise<Response | null> => {
  const store = options.ports.clientStore;
  const registered = (await store?.get(auth.clientId)) ?? null;

  if (!registered) {
    if (!unregisteredClientsAllowed(options)) {
      const codeSecretValues = await resolveSecrets(options.ports, request);
      await verifyClientSecretAny(auth.secret ?? DUMMY_SECRET, DUMMY_STORED_HASH, codeSecretValues);
      return invalidClientAudited(options, auth.clientId, "unknown client_id");
    }
    if (registeredClientsRequired(options)) {
      const codeSecretValues = await resolveSecrets(options.ports, request);
      const unsealed = await unsealAny<ClientAssertion>(codeSecretValues, "client", auth.clientId);
      if (!unsealed) {
        // CIMD URL client_ids were validated at /authorize; the sealed auth
        // code already binds clientId. Accept URL-shaped ids here so refresh
        // / revoke / code exchange are not rejected after a successful CIMD
        // authorize. Re-fetch is intentionally skipped — redirect_uris are
        // not re-checked at token time.
        if (options.cimd !== false && isCimdClientId(auth.clientId)) {
          return null;
        }
        return invalidClientAudited(
          options,
          auth.clientId,
          "client_id must come from clientStore or this server's own /register",
        );
      }
      if (unsealed.keyIndex > 0) {
        await safeOAuthAudit(options, {
          event: "legacy_code_secret_used",
          clientId: auth.clientId,
          reason: `client assertion unsealed with codeSecret[${unsealed.keyIndex}]`,
        });
      }
    }
    return null;
  }

  const expected = registered.tokenEndpointAuthMethod;
  if (expected === TOKEN_ENDPOINT_AUTH_METHODS.none) return null;

  // A known client_id failing here (wrong method, or right method but no
  // secret presented) still pays the same fixed comparison cost as one
  // that reaches the real verifyClientSecretAny call below with a wrong
  // secret — otherwise these two branches return measurably faster than
  // every other rejection path in this function, a timing signal for
  // "this client_id exists and requires a secret" distinct from "the
  // secret itself was wrong."
  if (auth.method !== expected) {
    const codeSecretValues = await resolveSecrets(options.ports, request);
    await verifyClientSecretAny(auth.secret ?? DUMMY_SECRET, DUMMY_STORED_HASH, codeSecretValues);
    return invalidClientAudited(
      options,
      auth.clientId,
      `client requires ${expected}, got ${auth.method}`,
    );
  }
  if (!auth.secret) {
    const codeSecretValues = await resolveSecrets(options.ports, request);
    await verifyClientSecretAny(DUMMY_SECRET, DUMMY_STORED_HASH, codeSecretValues);
    return invalidClientAudited(options, auth.clientId, "client_secret required");
  }

  if (store?.secretHash) {
    const codeSecretValues = await resolveSecrets(options.ports, request);
    const stored = await store.secretHash(auth.clientId);
    // Constant path whether a hash is on file or not — same reasoning as
    // the unregistered-client branch above.
    const { ok, keyIndex } = await verifyClientSecretAny(
      auth.secret,
      stored ?? DUMMY_STORED_HASH,
      codeSecretValues,
    );
    if (ok && stored !== null) {
      if (keyIndex !== null && keyIndex > 0) {
        await safeOAuthAudit(options, {
          event: "legacy_code_secret_used",
          clientId: auth.clientId,
          reason: `client_secret_hash verified with codeSecret[${keyIndex}]`,
        });
      }
      return null;
    }
    return invalidClientAudited(
      options,
      auth.clientId,
      stored === null ? "no secretHash on file for this client" : "secretHash mismatch",
    );
  }

  if (!store?.verifySecret) {
    return invalidClientAudited(
      options,
      auth.clientId,
      "clientStore.verifySecret is not configured",
    );
  }
  if (!(await store.verifySecret(auth.clientId, auth.secret))) {
    return invalidClientAudited(options, auth.clientId, "verifySecret returned false");
  }
  return null;
};
