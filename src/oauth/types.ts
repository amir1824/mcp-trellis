import { DEFAULT_SCOPE, type TokenEndpointAuthMethod } from "./constants.js";
import type { CodeStore } from "./codes.js";
import type { RedirectAllowlistOptions } from "./redirect.js";
import { jsonResponse } from "../http.js";

export type OAuthUser = { id: string };

/**
 * A client registered ahead of time (pre-registration).
 * Gemini Enterprise and other confidential clients arrive this way —
 * the org registers with its own IdP and configures the pair here.
 */
export type RegisteredClient = {
  clientId: string;
  /** Exact-match redirect URIs. Checked instead of the global allowlist. */
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
};

export type ClientStore = {
  /** Resolve a pre-registered client, or null when unknown. */
  get: (clientId: string) => Promise<RegisteredClient | null>;
  /**
   * Verify a presented client secret. Required for confidential clients.
   * Secret storage and comparison stay in your implementation — the library
   * never sees or persists credentials.
   */
  verifySecret?: (clientId: string, presented: string) => Promise<boolean>;
};

export type MintedToken = {
  accessToken: string;
  tokenType?: string;
  expiresIn: number;
  scope?: string;
  refreshToken?: string;
};

export type MintAccessTokenInput = {
  userId: string;
  clientId: string;
  scope: string;
  /** RFC 8707 resource — mint with aud bound to this URI. */
  resource: string;
};

export type RefreshAccessTokenInput = {
  refreshToken: string;
  clientId: string;
  /**
   * RFC 8707 resource for the refreshed access token.
   * Implementations MUST reject refresh tokens not originally issued for this resource.
   */
  resource: string;
};

export type OAuthPorts = {
  /** HMAC secret for signing auth codes. */
  codeSecret: string | ((req: Request) => string | Promise<string>);
  /** Resolve the logged-in user, or null → redirect to login. */
  resolveUser: (req: Request) => Promise<OAuthUser | null>;
  /** Where to send unauthenticated authorize requests. */
  loginUrl: (req: Request, nextPath: string) => string;
  /** Mint an access token bound to the consenting user and resource audience. */
  mintAccessToken: (input: MintAccessTokenInput) => Promise<MintedToken>;
  /** Optional refresh_token grant. Presence advertises the grant. */
  refreshAccessToken?: (
    input: RefreshAccessTokenInput,
  ) => Promise<MintedToken | null>;
  /** Shared single-use jti store for multi-instance; in-memory default otherwise. */
  codeStore?: CodeStore;
  /** Pre-registered clients. Required to serve confidential clients. */
  clientStore?: ClientStore;
};

export type OAuthRouterOptions = {
  ports: OAuthPorts;
  resourcePath?: string;
  oauthPath?: string;
  realm?: string;
  scopes?: string[];
  redirect?: RedirectAllowlistOptions;
  /** Advertised in AS metadata. Defaults to `["none"]` (public clients only). */
  tokenEndpointAuthMethods?: TokenEndpointAuthMethod[];
};

/** Scopes this AS advertises and is willing to grant. */
export const advertisedScopes = (options: OAuthRouterOptions): string[] =>
  options.scopes ?? [DEFAULT_SCOPE];

export const resolveSecret = async (
  ports: OAuthPorts,
  req: Request,
): Promise<string> => {
  if (typeof ports.codeSecret === "string") return ports.codeSecret;
  return ports.codeSecret(req);
};

export const oauthError = (
  error: string,
  status: number,
  description?: string,
): Response =>
  jsonResponse(
    description ? { error, error_description: description } : { error },
    status,
    undefined,
    { cors: false },
  );

/** `grantedScope` is what the auth code carried; the port may narrow it further. */
export const tokenResponse = (
  minted: MintedToken,
  grantedScope?: string,
): Response =>
  jsonResponse(
    {
      access_token: minted.accessToken,
      token_type: minted.tokenType ?? "bearer",
      expires_in: minted.expiresIn,
      scope: minted.scope ?? grantedScope ?? DEFAULT_SCOPE,
      ...(minted.refreshToken ? { refresh_token: minted.refreshToken } : {}),
    },
    200,
    undefined,
    { cors: false },
  );
