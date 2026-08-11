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
} as const;

export const DEFAULT_SCOPE = "mcp";
