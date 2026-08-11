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
  /** Client authentication failed, or the client is unknown. */
  invalidClient: "invalid_client",
  /** Requested scope exceeds what this server advertises. */
  invalidScope: "invalid_scope",
  /** RFC 8707 — requested resource is not acceptable. */
  invalidTarget: "invalid_target",
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
