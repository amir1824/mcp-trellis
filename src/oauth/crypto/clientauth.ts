/** Token-endpoint client authentication (RFC 6749 §2.3.1). */

import { auditLegacyKeyUsage, safeOAuthAudit } from "../audit.js";
import { cimdFetchOpts, isCimdClientId, resolveCimdClient } from "../cimd/cimd.js";
import {
  oauthError,
  registeredClientsRequired,
  resolveSecrets,
  unregisteredClientsAllowed,
} from "../config.js";
import {
  OAUTH_ERRORS,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "../constants.js";
import type {
  ClientAssertion,
  ClientStore,
  OAuthRouterOptions,
  RegisteredClient,
} from "../types.js";
import { unsealAny } from "./sealed.js";
import { verifyClientSecretAny } from "./secrethash.js";

export type ClientAuth = {
  clientId: string;
  secret: string | null;
  method: TokenEndpointAuthMethod;
};

/** RFC 7235 §2.1 — the auth-scheme token is case-insensitive. */
const BASIC_SCHEME_RE = /^basic\s+/i;

/** RFC 6749 §2.3.1 — id and secret are form-urlencoded, so `+` means a space. */
const decodeFormComponent = (value: string): string =>
  decodeURIComponent(value.replace(/\+/g, " "));

/** `Authorization: Basic base64(urlencode(id):urlencode(secret))`. */
const parseBasicAuth = (header: string | null): ClientAuth | null => {
  const scheme = header ? BASIC_SCHEME_RE.exec(header) : null;
  if (!header || !scheme) return null;
  try {
    const decoded = atob(header.slice(scheme[0].length).trim());
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    const clientId = decodeFormComponent(decoded.slice(0, separator));
    if (!clientId) return null;
    return {
      clientId,
      secret: decodeFormComponent(decoded.slice(separator + 1)),
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

/** One client-authentication attempt at `/token` or `/revoke`. */
type ClientAuthContext = {
  auth: ClientAuth;
  options: OAuthRouterOptions;
  request: Request;
};

/** The generic response every failure below returns to the caller. */
const invalidClient = (): Response =>
  oauthError(OAUTH_ERRORS.invalidClient, 401, CLIENT_AUTH_FAILED);

/** The response above, plus the real reason to `ports.audit` — never to the caller. */
const invalidClientAudited = async (
  { auth, options }: ClientAuthContext,
  reason: string,
): Promise<Response> => {
  await safeOAuthAudit(options, { event: "client_auth_failed", clientId: auth.clientId, reason });
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
 * Rejects with `reason`, but only after paying the same
 * `verifyClientSecretAny` cost a real (wrong-secret) rejection would — a
 * missing or empty secret is replaced by `DUMMY_SECRET`, so a caller who
 * presented nothing can't be told apart, by timing, from a wrong secret.
 */
const rejectWithDummyCompare = async (
  context: ClientAuthContext,
  reason: string,
): Promise<Response> => {
  const codeSecretValues = await resolveSecrets(context.options.ports, context.request);
  const presented = context.auth.secret || DUMMY_SECRET;
  await verifyClientSecretAny(presented, DUMMY_STORED_HASH, codeSecretValues);
  return invalidClientAudited(context, reason);
};

/**
 * True when `clientId` is this server's own sealed `/register` assertion or,
 * with CIMD enabled, a resolvable CIMD document. URL-shaped ids are always
 * re-resolved, never accepted by shape alone.
 */
const isSelfRegisteredOrCimdClient = async ({
  auth,
  options,
  request,
}: ClientAuthContext): Promise<boolean> => {
  const codeSecretValues = await resolveSecrets(options.ports, request);
  const unsealed = await unsealAny<ClientAssertion>(codeSecretValues, "client", auth.clientId);
  if (unsealed) {
    await auditLegacyKeyUsage(options, {
      clientId: auth.clientId,
      keyIndex: unsealed.keyIndex,
      source: "client assertion unsealed",
    });
    return true;
  }
  if (options.cimd !== true || !isCimdClientId(auth.clientId)) return false;

  if (await resolveCimdClient(auth.clientId, cimdFetchOpts(options))) return true;
  // Without `cimdCache` every refresh/revoke re-fetches — a flaky document
  // host logs users out. Surface that distinctly.
  await safeOAuthAudit(options, {
    event: "cimd_resolve_failed",
    clientId: auth.clientId,
    reason: "CIMD document could not be resolved at token/revoke time",
  });
  return false;
};

/**
 * An unknown client_id is treated as public — PKCE is its only proof —
 * unless `allowUnregisteredClients` is false, in which case it is rejected.
 * On that locked-down path a dummy secret comparison runs even for a
 * client_id this server has never heard of, so timing can't distinguish
 * "unknown" from "known, wrong secret". Public clients never pay that cost.
 *
 * Under `requireRegisteredClients`, a client_id resolved by neither
 * `clientStore`, this server's own sealed `/register` assertion, nor CIMD is
 * rejected — the same rule `/authorize` enforces. It lives in this shared
 * gate so the `refresh_token` grant and `/revoke` cannot be reached with an
 * invented id that never went through `/authorize`.
 */
const unregisteredClientAuthError = async (
  context: ClientAuthContext,
): Promise<Response | null> => {
  if (!unregisteredClientsAllowed(context.options)) {
    return rejectWithDummyCompare(context, "unknown client_id");
  }
  if (!registeredClientsRequired(context.options)) return null;
  if (await isSelfRegisteredOrCimdClient(context)) return null;
  return invalidClientAudited(
    context,
    "client_id must come from clientStore or this server's own /register",
  );
};

/** Compare against `ClientStore.secretHash` — the same cost whether a hash is on file or not. */
const secretHashAuthError = async (
  context: ClientAuthContext,
  secret: string,
  secretHash: NonNullable<ClientStore["secretHash"]>,
): Promise<Response | null> => {
  const { auth, options, request } = context;
  const codeSecretValues = await resolveSecrets(options.ports, request);
  const stored = await secretHash(auth.clientId);
  const { ok, keyIndex } = await verifyClientSecretAny(
    secret,
    stored ?? DUMMY_STORED_HASH,
    codeSecretValues,
  );
  if (ok && stored !== null) {
    await auditLegacyKeyUsage(options, {
      clientId: auth.clientId,
      keyIndex,
      source: "client_secret_hash verified",
    });
    return null;
  }
  return invalidClientAudited(
    context,
    stored === null ? "no secretHash on file for this client" : "secretHash mismatch",
  );
};

/** Delegate the comparison to the host's `ClientStore.verifySecret`. */
const verifySecretAuthError = async (
  context: ClientAuthContext,
  secret: string,
  verifySecret: ClientStore["verifySecret"],
): Promise<Response | null> => {
  if (!verifySecret) {
    return invalidClientAudited(context, "clientStore.verifySecret is not configured");
  }
  if (!(await verifySecret(context.auth.clientId, secret))) {
    return invalidClientAudited(context, "verifySecret returned false");
  }
  return null;
};

/** Enforce a known client's own `tokenEndpointAuthMethod`. */
const registeredClientAuthError = async (
  context: ClientAuthContext,
  registered: RegisteredClient,
): Promise<Response | null> => {
  const { auth, options } = context;
  const expected = registered.tokenEndpointAuthMethod;
  if (expected === TOKEN_ENDPOINT_AUTH_METHODS.none) return null;

  // A wrong method or a missing secret pays the same comparison cost as a
  // wrong secret, so neither branch leaks "this client exists and needs a
  // secret" through response timing.
  if (auth.method !== expected) {
    return rejectWithDummyCompare(context, `client requires ${expected}, got ${auth.method}`);
  }
  if (!auth.secret) return rejectWithDummyCompare(context, "client_secret required");

  const store = options.ports.clientStore;
  return store?.secretHash
    ? secretHashAuthError(context, auth.secret, store.secretHash)
    : verifySecretAuthError(context, auth.secret, store?.verifySecret);
};

/** Enforce the registered auth method for known clients — see the helpers above for each branch. */
export const firstClientAuthError = async (
  auth: ClientAuth,
  options: OAuthRouterOptions,
  request: Request,
): Promise<Response | null> => {
  const context: ClientAuthContext = { auth, options, request };
  const registered = (await options.ports.clientStore?.get(auth.clientId)) ?? null;
  return registered
    ? registeredClientAuthError(context, registered)
    : unregisteredClientAuthError(context);
};
