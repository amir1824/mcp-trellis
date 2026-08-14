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
  /** Token endpoint — client authentication failed, or the client is unknown. */
  invalidClient: "invalid_client",
  /** Authorization endpoint — this client may not use this method. RFC 6749 §4.1.2.1. */
  unauthorizedClient: "unauthorized_client",
  /** Requested scope exceeds what this server advertises. */
  invalidScope: "invalid_scope",
  /** RFC 8707 — requested resource is not acceptable. */
  invalidTarget: "invalid_target",
  /** A host port threw. RFC 6749 §4.1.2.1 / §5.2 — our fault, not the client's. */
  serverError: "server_error",
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
