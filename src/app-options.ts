import type { ClientName } from "./clients.js";
import type { AuditEntry, Principal, ServerInfo } from "./methods.js";
import type { CodeStore } from "./oauth/codes.js";
import type { ConsentOptions } from "./oauth/consent.js";
import type {
  ClientStore,
  MintAccessTokenInput,
  MintedToken,
  OAuthAuditEntry,
  OAuthUser,
  RefreshAccessTokenInput,
  RevokeTokenInput,
} from "./oauth/types.js";
import type { ToolDef } from "./registry.js";

/** What your token verification returns. The library checks the audience. */
export type VerifiedToken = {
  userId: string;
  scopes: string[];
  /** RFC 8707 audience the token was minted for. */
  audience: string;
  /** Optional host claims passed through to `context` via `Principal`. */
  claims?: Record<string, unknown>;
};

export type McpAppAuth = {
  /**
   * Secret(s) that seal auth codes, consent tickets, and self-issued DCR
   * client assertions, and key `ClientStore.secretHash`. A single string
   * works exactly as before; pass an array for key rotation — the first
   * entry seals new material, every entry is tried when unsealing/verifying.
   * See `OAuthPorts.codeSecret` for the full rotation contract.
   */
  codeSecret:
    | string
    | string[]
    | ((req: Request) => string | string[] | Promise<string | string[]>);
  /** Resolve the logged-in user, or null → redirect to `loginUrl`. */
  resolveUser: (req: Request) => Promise<OAuthUser | null>;
  /** Where to send unauthenticated authorize requests. */
  loginUrl: (req: Request, nextPath: string) => string;
  /** Mint an access token; embed `resource` as the audience. */
  mintAccessToken: (input: MintAccessTokenInput) => Promise<MintedToken>;
  /**
   * Decode and validate a bearer token. Return its `audience` —
   * `createMcpApp` rejects tokens minted for a different resource itself,
   * so this check cannot be forgotten.
   */
  verifyToken: (token: string, req: Request) => Promise<VerifiedToken | null>;
  refreshAccessToken?: (input: RefreshAccessTokenInput) => Promise<MintedToken | null>;
  /** RFC 7009 — presence mounts `/revoke` and advertises it. */
  revokeToken?: (input: RevokeTokenInput) => Promise<void>;
  codeStore?: CodeStore;
  /** Required when any configured client is pre-registered (e.g. Gemini). */
  clientStore?: ClientStore;
  /**
   * Opt-in OAuth-side metrics hook — see the tool-call `audit` below for
   * the general shape. This one sees the real reason behind a collapsed
   * `invalid_client` or a rejected `codeSecret`, which the caller never
   * does. Omit for silence.
   */
  audit?: (entry: OAuthAuditEntry) => void | Promise<void>;
};

export type McpAppOptions<TCtx> = {
  serverInfo: ServerInfo;
  tools: ToolDef<TCtx>[];
  auth: McpAppAuth;
  /** Connector clients to serve. Default: `["claude"]`. */
  clients?: ClientName[];
  instructions?: string;
  /** MCP endpoint path. Default `"/mcp"`. */
  resourcePath?: string;
  /** OAuth prefix. Default `` `${resourcePath}/oauth` ``. */
  oauthPath?: string;
  /** Scopes this server grants. Default `["mcp"]`. */
  scopes?: string[];
  /** Required when `scopes` has more than one entry — see `OAuthRouterOptions.defaultScopes`. */
  defaultScopes?: string[];
  realm?: string;
  /** Extra exact-match redirect URIs beyond the client profiles. */
  extraRedirectUris?: string[];
  /** Allow loopback redirects (native clients). Default true. */
  allowLoopback?: boolean;
  /**
   * Consent policy — policy, not a credential, so it sits alongside
   * `allowLoopback` rather than under `auth`. Omit for the built-in
   * hardened interstitial.
   */
  consent?: ConsentOptions;
  /**
   * Require every `client_id` to come from `clientStore` or this server's
   * own `/register` (sealed assertion). Default **true** since 1.0.
   * Set false only to accept invented public ids (pre-CIMD).
   */
  requireRegisteredClients?: boolean;
  validateArgs?: boolean;
  onToolError?: (error: unknown) => string;
  /** Per-request context for tools. Defaults to an empty object. */
  context?: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  /**
   * Opt-in metrics hook — same as `McpPorts.audit`. Omit for silence. The
   * library never stores or prints these itself. See `consoleAudit` or
   * `examples/audit-store.ts`.
   */
  audit?: (entry: AuditEntry) => void | Promise<void>;
  /** Max time to wait for `audit` above before responding anyway. Default 1000ms. Also applied to `auth.audit`. */
  auditTimeoutMs?: number;
  /**
   * Browser `Origin` allowlist for `/mcp` — see `McpHandlerOptions.allowedRequestOrigins`.
   * Omitted → reject any request that sends `Origin`. Native clients omit the header.
   */
  allowedRequestOrigins?: string[];
  /** Filter `tools/list` by scope. See `McpHandlerOptions.hideToolsOutsideScope`. Default false. */
  hideToolsOutsideScope?: boolean;
};
