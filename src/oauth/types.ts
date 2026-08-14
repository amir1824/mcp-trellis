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

export type RevokeTokenInput = {
  token: string;
  clientId: string;
  tokenTypeHint?: "access_token" | "refresh_token";
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
  /**
   * RFC 7009. Presence mounts `/revoke` and advertises `revocation_endpoint`.
   * Well-formed authenticated revoke is HTTP 200 even if the token is unknown
   * (`invalid_request` / `invalid_client` still apply). `verifyToken` and
   * `refreshAccessToken` MUST consult the same store; unknown tokens and
   * tokens not issued to `clientId` MUST no-op (not throw).
   */
  revokeToken?: (input: RevokeTokenInput) => Promise<void>;
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
  /**
   * Allow a `client_id` not resolved by `clientStore` to authorize and
   * exchange tokens as a public client (PKCE only — no secret).
   *
   * Default **true** (DCR / CIMD connectors). Set **false** when every
   * client is pre-registered: `/register` is unmounted, dropped from AS
   * metadata, and an unrecognized `client_id` is rejected with
   * `unauthorized_client` at `authorize` and `invalid_client` at `token`
   * and `revoke`. `createMcpApp` derives this from `clients` via
   * `hasDynamicClient`.
   */
  allowUnregisteredClients?: boolean;
};

/** Default true — see `OAuthRouterOptions.allowUnregisteredClients`. */
export const unregisteredClientsAllowed = (
  options: OAuthRouterOptions,
): boolean => options.allowUnregisteredClients !== false;

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

const UNREGISTERED_CLIENT_DESCRIPTION =
  "unknown client_id — this server only serves pre-registered clients";

/** Direct JSON error when this AS does not serve unknown `client_id`s. */
export const unregisteredClientError = (
  options: OAuthRouterOptions,
  reject: { code: string; status: number },
): Response | null => {
  if (unregisteredClientsAllowed(options)) return null;
  return oauthError(
    reject.code,
    reject.status,
    UNREGISTERED_CLIENT_DESCRIPTION,
  );
};

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
