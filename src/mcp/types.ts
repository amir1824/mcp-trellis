import type { WwwAuthenticateOptions } from "../auth/bearer.js";
import type { ToolRegistry } from "./registry.js";

export type Principal = {
  id: string;
  /**
   * Granted scopes. The literal `"*"` is a wildcard that satisfies **every**
   * tool `scope` check (see `hasScope`) — reserve it for trusted internal
   * principals; never mint it for an external connector.
   */
  scopes: string[];
  /** Optional host claims from `verifyToken` (tenant, plan, role, …). */
  claims?: Record<string, unknown> | undefined;
};

/** Per-request metrics emitted through the optional `audit` port. */
export type AuditEntry = {
  /** JSON-RPC method, or `""` for transport-level rejections made before parsing. */
  method: string;
  tool?: string | undefined;
  principalId?: string | undefined;
  ok: boolean;
  error?: string | undefined;
  durationMs: number;
};

export type McpPorts<TCtx> = {
  authenticate: (req: Request, method: string, tool?: string) => Promise<Principal | null>;
  /**
   * Builds the tool context. Called only for a `tools/call` that passed the
   * unknown-tool and scope checks — never for `initialize`, `ping` or
   * `tools/list`. `principal` is null only when a host adds `tools/call`
   * to `publicMethods`.
   */
  context: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  /**
   * Opt-in metrics hook. Pass any function to receive tool results and auth
   * denials (bad token, missing scope, query-string token), plus the 500
   * path when a host port throws. Protocol errors (malformed JSON, bad
   * `jsonrpc`, unsupported protocol version, oversized body, batch) are not
   * audited. Omit it and the library stays silent — no stdout, no store.
   * Do what you want with `entry` (DB, APM, admin UI). Throwing never fails
   * the request, and neither does hanging — see
   * `McpHandlerOptions.auditTimeoutMs`.
   */
  audit?: ((entry: AuditEntry) => void | Promise<void>) | undefined;
};

export type ServerInfo = {
  name: string;
  version: string;
};

export type McpHandlerOptions<TCtx> = {
  registry: ToolRegistry<TCtx>;
  ports: McpPorts<TCtx>;
  serverInfo: ServerInfo;
  instructions?: string;
  wwwAuthenticate: WwwAuthenticateOptions | ((req: Request) => WwwAuthenticateOptions);
  /** Methods that skip auth (default: initialize, ping, notifications/*). */
  publicMethods?: Set<string>;
  /**
   * Max time to wait for `ports.audit` before giving up on it and
   * responding anyway. Default 1000ms. A hanging audit sink can't fail a
   * request (see `safeAudit`), but without this it could stall one
   * indefinitely — "can't fail" isn't "can't delay."
   */
  auditTimeoutMs?: number;
  /**
   * Browser `Origin` header allowlist for MCP (DNS rebinding / CSRF).
   * Distinct from Node Host `allowedOrigins` on `asNodeHandler`.
   * No `Origin` → allowed (native clients). Omitted/empty → reject any
   * present `Origin`. `"*"` admits any Origin.
   */
  allowedRequestOrigins?: string[];
  /**
   * Filter `tools/list` down to tools the calling principal's scopes
   * actually satisfy (an unscoped tool is always listed). Default
   * **false** — every tool is always listed, `tools/call` is what enforces
   * scope (with a **403** `insufficient_scope`, see `insufficientScope`).
   * Turning this on trades that step-up signal away: a client can no
   * longer discover "this tool exists, ask for its scope" from `tools/list`
   * for a scope it doesn't hold — only worth it if listing a tool at all
   * would leak something (its name, description, or schema) you don't want
   * a lesser-scoped principal to see.
   */
  hideToolsOutsideScope?: boolean;
};

/** `McpHandlerOptions` after `createMcpHandler` resolved its defaults. */
export type ResolvedMcpHandlerOptions<TCtx> = McpHandlerOptions<TCtx> & {
  publicMethods: Set<string>;
};
