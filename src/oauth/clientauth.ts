/** Token-endpoint client authentication (RFC 6749 §2.3.1). */

import {
  OAUTH_ERRORS,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "./constants.js";
import {
  oauthError,
  unregisteredClientError,
  type OAuthRouterOptions,
} from "./types.js";

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
    method: secret.length > 0
      ? TOKEN_ENDPOINT_AUTH_METHODS.post
      : TOKEN_ENDPOINT_AUTH_METHODS.none,
  };
};

const invalidClient = (description: string): Response =>
  oauthError(OAUTH_ERRORS.invalidClient, 401, description);

/**
 * Enforce the registered auth method for known clients.
 *
 * An unknown client_id is treated as public — PKCE is its only proof —
 * unless `allowUnregisteredClients` is false, in which case it is rejected
 * rather than silently falling back to "no auth required".
 */
export const firstClientAuthError = async (
  auth: ClientAuth,
  options: OAuthRouterOptions,
): Promise<Response | null> => {
  const store = options.ports.clientStore;
  const registered = (await store?.get(auth.clientId)) ?? null;
  if (!registered) {
    return unregisteredClientError(options, {
      code: OAUTH_ERRORS.invalidClient,
      status: 401,
    });
  }

  const expected = registered.tokenEndpointAuthMethod;
  if (expected === TOKEN_ENDPOINT_AUTH_METHODS.none) return null;

  if (auth.method !== expected) {
    return invalidClient(`client requires ${expected}`);
  }
  if (!auth.secret) return invalidClient("client_secret required");
  if (!store?.verifySecret) {
    return invalidClient("clientStore.verifySecret is not configured");
  }
  if (!(await store.verifySecret(auth.clientId, auth.secret))) {
    return invalidClient("client authentication failed");
  }
  return null;
};
