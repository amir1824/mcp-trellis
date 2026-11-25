import type { ClientName } from "./clients.js";
import type { ToolDef } from "./mcp/registry.js";
import type { ResourceDef } from "./mcp/resources/types.js";
import type { SchemaValidator } from "./mcp/schema/types.js";
import type { SkillDef } from "./mcp/skills/types.js";
import type { AuditEntry, Principal, ServerInfo } from "./mcp/types.js";
import type { UiResource } from "./mcp/ui/types.js";
import type { CimdPorts } from "./oauth/cimd/types.js";
import type { CodeStore } from "./oauth/crypto/codes.js";
import type {
  ClientStore,
  ConsentOptions,
  MintAccessTokenInput,
  MintedToken,
  OAuthAuditEntry,
  OAuthUser,
  RefreshAccessTokenInput,
  RevokeTokenInput,
} from "./oauth/types.js";

/** One sink for both MCP tool-call and OAuth AS audit events. */
export type UnifiedAuditEntry =
  | ({ source: "mcp" } & AuditEntry)
  | ({ source: "oauth" } & OAuthAuditEntry);

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
   * client assertions, and key `ClientStore.secretHash`. Pass a string, or
   * an array for key rotation — the first
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
  /**
   * Validate tools/call args against each tool's `inputSchema`. Default
   * **true** since 2.0. Set false only to skip schema checks intentionally.
   */
  validateArgs?: boolean;
  /**
   * Check each successful tool result against the tool's `outputSchema`; a result that does not
   * conform becomes the generic error "Tool returned an invalid result". Default: follows
   * `validateArgs` (**true**). See `RegistryOptions.validateOutput`.
   */
  validateOutput?: boolean;
  /**
   * Receives the tool name and the violations of a result rejected by `outputSchema`. They can
   * contain the result's data, so log them server-side only. See `RegistryOptions.onOutputViolation`.
   */
  onOutputViolation?: (tool: string, violations: string[]) => void;
  /**
   * Replaces the built-in JSON Schema evaluator for tool inputs and outputs (for example with
   * Ajv); the construction-time keyword and `pattern` checks are then yours. See
   * `RegistryOptions.schemaValidator`.
   */
  schemaValidator?: SchemaValidator;
  /**
   * See `OAuthRouterOptions.allowInMemoryCodeStore`. Default false.
   */
  allowInMemoryCodeStore?: boolean;
  /**
   * Opt into CIMD (HTTPS URL `client_id`s). Default **false** — see
   * `OAuthRouterOptions.cimd`.
   */
  cimd?: boolean;
  onToolError?: (error: unknown) => string;
  /**
   * Per-call context for tools, built only when a `tools/call` is about to
   * run (see `McpPorts.context`). Defaults to an empty object.
   */
  context?: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  /**
   * Unified metrics hook for MCP and OAuth events (`source: "mcp" | "oauth"`).
   * Omit for silence. `auth.audit` overrides OAuth delivery when both are set.
   * See `consoleAudit` or `examples/audit-store.ts`.
   */
  audit?: (entry: UnifiedAuditEntry) => void | Promise<void>;
  /** Max time to wait for `audit` above before responding anyway. Default 1000ms. Also applied to `auth.audit`. */
  auditTimeoutMs?: number;
  /**
   * Browser `Origin` allowlist for `/mcp` — see `McpHandlerOptions.allowedRequestOrigins`.
   * Omitted → reject any request that sends `Origin`. Native clients omit the header.
   */
  allowedRequestOrigins?: string[];
  /** Filter `tools/list` by scope. See `McpHandlerOptions.hideToolsOutsideScope`. Default false. */
  hideToolsOutsideScope?: boolean | "strict";
  /**
   * MCP Apps: UI documents that tools reference with `ToolDef.ui` — see
   * `McpHandlerOptions.uiResources` and `docs/mcp-apps.md`.
   */
  uiResources?: UiResource[];
  /**
   * General resources next to `uiResources`: fixed URIs gated by `scope` and `allow` — see
   * `McpHandlerOptions.resources` and `docs/resources.md`.
   */
  resources?: ResourceDef<TCtx>[];
  /** @experimental Skills over MCP, off unless set: see `McpHandlerOptions.skills` and `docs/skills.md`. */
  skills?: SkillDef[];
} & CimdPorts;
