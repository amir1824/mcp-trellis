import type { CimdCache } from "./cimd/types.js";
import type { TokenEndpointAuthMethod } from "./constants.js";
import type { CodeStore } from "./crypto/codes.js";
import type { RedirectAllowlistOptions } from "./policy/redirect.js";

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

export type ConsentRequest = {
  clientId: string;
  registeredClient: RegisteredClient | null;
  redirectUri: string;
  scope: string[];
  resource: string;
  user: OAuthUser;
  /** Embed this in your form's `consent_ticket` field (hidden input or POST body). */
  ticket: string;
  oauthPath: string;
};

export type ConsentOptions = {
  /**
   * Render the approval page yourself. Return any `Response` — HTML, or a
   * redirect to your own route. Omit for the built-in hardened interstitial.
   *
   * If your page sets its own `Content-Security-Policy` with `form-action`,
   * include `new URL(input.redirectUri).origin` in it — Chromium enforces
   * `form-action` across the redirect your approval POST triggers, not just
   * the immediate submission target, so `'self'` alone blocks the eventual
   * redirect back to the client's own callback.
   */
  render?: (input: ConsentRequest) => Response | Promise<Response>;
  /**
   * Client ids that skip approval. Only honored when `clientStore` actually
   * resolves the id — a DCR or self-invented id is never trusted.
   */
  preApprovedClientIds?: string[];
};

/**
 * The payload sealed into a `client_id` this server itself issued via
 * `/register` (see `sealed.ts`, type `"client"`). Zero storage: the id
 * *is* the registration record, self-verifying against `codeSecret`.
 */
export type ClientAssertion = {
  redirectUris: string[];
  /**
   * Unix seconds when `/register` sealed this assertion. Informational only
   * — not enforced as an expiry — so it can help an operator judge how old
   * a still-valid DCR client is. Optional on read: an assertion sealed
   * before this field existed still unseals and works.
   */
  iat?: number;
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
  /**
   * RFC 6749 §6 — optional scope reduction requested by the client.
   * When set, the library validates against advertised `scopes` only.
   * Implementations MUST also reject any scope outside what was originally
   * granted to this refresh token (the library cannot see opaque RTs).
   */
  scope?: string;
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
  /**
   * Secret(s) that seal auth codes, consent tickets, and self-issued DCR
   * client assertions (`sealed.ts`), and key `ClientStore.secretHash`.
   *
   * Pass a single string, or for key rotation an array: the **first** entry seals new material and hashes new client
   * secrets; **every** entry is tried when unsealing/verifying, so material
   * sealed under an older key keeps working until you drop it from the
   * array. `ports.audit` sees a `"legacy_code_secret_used"` event whenever
   * anything but the first entry was the one that actually verified,
   * so you know when it's safe to remove.
   */
  codeSecret:
    | string
    | string[]
    | ((req: Request) => string | string[] | Promise<string | string[]>);
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
  /** Shared single-use jti store for multi-instance. Required unless `allowInMemoryCodeStore`. */
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
  /**
   * Max time to wait for `ports.audit` before responding anyway. Default
   * 1000ms — same guarantee as `McpHandlerOptions.auditTimeoutMs`.
   */
  auditTimeoutMs?: number;
  /**
   * Allow the process-local in-memory jti Map when `ports.codeStore` is
   * omitted. Default **false** since 2.0 — multi-instance deploys silently
   * double-redeem auth codes without a shared store. Set true only for
   * single-process demos and tests.
   */
  allowInMemoryCodeStore?: boolean;
  /**
   * Resolve Client ID Metadata Documents (HTTPS URL `client_id`s).
   * Default **false** — opt in with `cimd: true`. Off until connect-pinned
   * fetch exists; see `cimd.ts` ponytail.
   */
  cimd?: boolean;
  /**
   * CIMD document cache (respects Cache-Control max-age, capped at 1 h).
   * **Strongly recommended with `cimd: true`:** without it `/token` and
   * `/revoke` re-fetch the client's document on every call, so a flaky
   * document host fails refresh/revoke (audited as `cimd_resolve_failed`).
   */
  cimdCache?: CimdCache;
  /** Optional DNS lookup for CIMD SSRF checks — see `CimdFetchOptions.lookup`. */
  cimdLookup?: (hostname: string) => Promise<string[]>;
};

/**
 * `OAuthRouterOptions` after `createOAuthRouter` has resolved them: paths
 * normalized and `ports.codeStore` always present, so no endpoint handler
 * can fall back to a store of its own. Internal — not re-exported.
 */
export type ResolvedOAuthRouterOptions = OAuthRouterOptions & {
  resourcePath: string;
  oauthPath: string;
  ports: OAuthPorts & { codeStore: CodeStore };
};

/**
 * An OAuth error's code and description without a `Response` built yet —
 * lets a caller choose delivery: `oauthError` for a direct JSON body, or a
 * redirect to the client's own callback (RFC 6749 §4.1.2.1).
 */
export type OAuthErrorInfo = { code: string; description: string };
