export const GRANT_TYPES = {
  authorizationCode: "authorization_code",
  refreshToken: "refresh_token",
} as const;

export type GrantType = (typeof GRANT_TYPES)[keyof typeof GRANT_TYPES];

export const OAUTH_ERRORS = {
  invalidRequest: "invalid_request",
  invalidGrant: "invalid_grant",
  unsupportedGrantType: "unsupported_grant_type",
  invalidRedirectUri: "invalid_redirect_uri",
  /** RFC 7591 §3.2.2 — DCR `/register`: a client metadata field's value itself is invalid. */
  invalidClientMetadata: "invalid_client_metadata",
  /** Token endpoint — client authentication failed, or the client is unknown. */
  invalidClient: "invalid_client",
  /** Authorization endpoint — this client may not use this method. RFC 6749 §4.1.2.1. */
  unauthorizedClient: "unauthorized_client",
  /** Authorization endpoint — `response_type` isn't one this server supports. RFC 6749 §4.1.2.1. */
  unsupportedResponseType: "unsupported_response_type",
  /** Requested scope exceeds what this server advertises. */
  invalidScope: "invalid_scope",
  /** RFC 8707 — requested resource is not acceptable. */
  invalidTarget: "invalid_target",
  /** A host port threw. RFC 6749 §4.1.2.1 / §5.2 — our fault, not the client's. */
  serverError: "server_error",
  /** RFC 6749 §4.1.2.1 — the resource owner denied consent. */
  accessDenied: "access_denied",
} as const;

export const TOKEN_ENDPOINT_AUTH_METHODS = {
  /** Public client — PKCE is the only proof. */
  none: "none",
  /** Credentials in the Authorization header. */
  basic: "client_secret_basic",
  /** Credentials in the request body. */
  post: "client_secret_post",
} as const;

export type TokenEndpointAuthMethod =
  (typeof TOKEN_ENDPOINT_AUTH_METHODS)[keyof typeof TOKEN_ENDPOINT_AUTH_METHODS];

export const DEFAULT_SCOPE = "mcp";

/** Default OAuth path prefix when `oauthPath` is unset. Router, `/authorize`, and metadata must agree. */
export const DEFAULT_OAUTH_PATH = "/mcp/oauth";

/**
 * Cap on a client's redirect URIs, self-registered or from a CIMD document.
 * RFC 7591 sets none, but `/register` seals the whole list into the
 * `client_id`, which then travels as an `/authorize` query parameter with
 * real length ceilings (browsers, proxies, logs). A client needs a handful.
 */
export const MAX_CLIENT_REDIRECT_URIS = 10;
