import { jsonResponse } from "../http.js";
import type { CodeStore } from "./codes.js";
import type { ConsentOptions } from "./consent.js";
import { DEFAULT_SCOPE, type TokenEndpointAuthMethod } from "./constants.js";
import type { RedirectAllowlistOptions } from "./redirect.js";

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

/**
 * The payload sealed into a `client_id` this server itself issued via
 * `/register` (see `sealed.ts`, type `"client"`). Zero storage: the id
 * *is* the registration record, self-verifying against `codeSecret`.
 */
export type ClientAssertion = {
  redirectUris: string[];
};

export type ClientStore = {
  /** Resolve a pre-registered client, or null when unknown. */
  get: (clientId: string) => Promise<RegisteredClient | null>;
  /**
   * Verify a presented client secret yourself. Secret storage and
   * comparison stay entirely in your implementation — the library never
   * sees or persists credentials. Prefer `secretHash` below when you can:
   * a hand-rolled `stored === presented` here is a timing oracle with no
   * warning from the library.
   */
  verifySecret?: (clientId: string, presented: string) => Promise<boolean>;
  /**
   * Preferred over `verifySecret`: return the stored hash (from
   * `hashClientSecret`) for `clientId`, or `null` when unknown, and the
   * library does the comparison with the same constant-time primitive it
   * uses everywhere else. Checked first when both are present. See
   * `secrethash.ts`.
   */
  secretHash?: (clientId: string) => Promise<string | null>;
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
  tokenTypeHint?: "access_token" | "refresh_token" | undefined;
};

/**
 * OAuth-side metrics hook, mirroring `McpPorts.audit` on the MCP side.
 * `reason` is intentionally more specific than what the caller ever sees —
 * `/token` and `/revoke` collapse every client-auth failure to one generic
 * `invalid_client` (closing an enumeration oracle; see `clientauth.ts`),
 * and a rejected `codeSecret` surfaces to the caller only as `server_error`
 * — this port is where an operator gets the real reason back, without
 * handing it to an unauthenticated caller.
 */
export type OAuthAuditEntry = {
  /** Machine-stable event name, e.g. "client_auth_failed", "server_error". */
  event: string;
  clientId?: string | undefined;
  reason: string;
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
  refreshAccessToken?:
    | ((input: RefreshAccessTokenInput) => Promise<MintedToken | null>)
    | undefined;
  /**
   * RFC 7009. Presence mounts `/revoke` and advertises `revocation_endpoint`.
   * Well-formed authenticated revoke is HTTP 200 even if the token is unknown
   * (`invalid_request` / `invalid_client` still apply). `verifyToken` and
   * `refreshAccessToken` MUST consult the same store; unknown tokens and
   * tokens not issued to `clientId` MUST no-op (not throw).
   */
  revokeToken?: ((input: RevokeTokenInput) => Promise<void>) | undefined;
  /** Shared single-use jti store for multi-instance; in-memory default otherwise. */
  codeStore?: CodeStore | undefined;
  /** Pre-registered clients. Required to serve confidential clients. */
  clientStore?: ClientStore | undefined;
  /**
   * Opt-in metrics hook. Pass any function to see the real reason behind a
   * collapsed `invalid_client` or a rejected `codeSecret`. Omit it and the
   * library stays silent. Throwing never fails the request — same
   * guarantee as `McpPorts.audit`.
   */
  audit?: ((entry: OAuthAuditEntry) => void | Promise<void>) | undefined;
};

/**
 * Invoke `ports.audit`, swallowing any failure — the OAuth-side twin of
 * `methods.ts`'s `safeAudit`. No timeout wrapper here: unlike the MCP
 * side, nothing here is expected to be a slow, request-scoped metrics
 * call in the same way, and adding one would be complexity without a
 * demonstrated need — revisit if that changes.
 */
export const safeOAuthAudit = async (
  options: OAuthRouterOptions,
  entry: OAuthAuditEntry,
): Promise<void> => {
  try {
    await options.ports.audit?.(entry);
  } catch {
    // Intentionally ignored.
  }
};

export type OAuthRouterOptions = {
  ports: OAuthPorts;
  resourcePath?: string;
  oauthPath?: string;
  realm?: string;
  scopes?: string[];
  /**
   * Scopes granted when a client omits `scope` entirely. Required when
   * `scopes` advertises more than one — with only one advertised scope
   * there's no escalation to prevent, so it defaults to that scope.
   * Must be a subset of `scopes`.
   */
  defaultScopes?: string[];
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
  /**
   * Require every `client_id` to have gone through `clientStore` or this
   * server's own `/register` (whose issued ids are self-verifying sealed
   * assertions — see `sealed.ts`). Unlike `allowUnregisteredClients: false`,
   * DCR stays mounted; a client just can't invent an id out of thin air.
   *
   * Default **true** since 1.0. Set **false** only when you intentionally
   * accept arbitrary public `client_id`s (pre-CIMD connectors that invent ids).
   */
  requireRegisteredClients?: boolean;
  /**
   * Consent policy. Policy, not a credential — sits alongside `redirect`,
   * not under `ports`. Omit for the built-in hardened interstitial.
   */
  consent?: ConsentOptions;
};

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
 * The literals here are the exact strings this package's own docs/examples
 * publish — copy-paste is the realistic failure mode.
 */
const MIN_CODE_SECRET_LENGTH = 32;
const DENYLISTED_CODE_SECRETS = new Set([
  "e2e-code-secret-value",
  "change-me",
  "test-secret-value",
]);
const GENERATE_HINT = "generate one with `openssl rand -base64 32`";

export const assertCodeSecret = (secret: string): void => {
  // Checked before the length rule so a denylisted literal is always named
  // for what it is, even if a future literal happens to be 32+ characters.
  if (DENYLISTED_CODE_SECRETS.has(secret)) {
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

export const resolveSecret = async (ports: OAuthPorts, req: Request): Promise<string> => {
  const secret =
    typeof ports.codeSecret === "string" ? ports.codeSecret : await ports.codeSecret(req);
  assertCodeSecret(secret);
  return secret;
};

/**
 * An OAuth error's code and description without a `Response` built yet —
 * lets a caller choose delivery: `oauthError` below for a direct JSON
 * body, or a redirect to the client's own callback (RFC 6749 §4.1.2.1,
 * see `authorize.ts` and `consent.ts`).
 */
export type OAuthErrorInfo = { code: string; description: string };

export const oauthError = (error: string, status: number, description?: string): Response =>
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
  return oauthError(reject.code, reject.status, UNREGISTERED_CLIENT_DESCRIPTION);
};

/** `grantedScope` is what the auth code carried; the port may narrow it further. */
export const tokenResponse = (minted: MintedToken, grantedScope?: string): Response =>
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
