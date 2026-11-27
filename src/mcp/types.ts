import type { WwwAuthenticateOptions } from "../auth/bearer.js";
import type { JsonRpcId, JsonRpcRequest } from "./jsonrpc.js";
import type { ClientContext } from "./modern/extensions.js";
import type { ToolRegistry } from "./registry.js";
import type { ResourceCatalog, ResourceDef } from "./resources/types.js";
import type { SkillDef, SkillIndex } from "./skills/types.js";
import type { UiResource } from "./ui/types.js";

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
  /** The URI of a `resources/read`, clipped like a tool name. */
  resource?: string | undefined;
  principalId?: string | undefined;
  ok: boolean;
  error?: string | undefined;
  /** The `MCP-Protocol-Version` of a request refused for it, clipped. */
  protocolVersion?: string | undefined;
  durationMs: number;
};

export type McpPorts<TCtx> = {
  authenticate: (req: Request, method: string, tool?: string) => Promise<Principal | null>;
  /**
   * Builds the tool context. Called only for a `tools/call` that passed the
   * unknown-tool and scope checks, or a general `resources/read` that passed
   * every access check — never for `initialize`, `ping`, `tools/list`,
   * `resources/list` or a `ui://` read. `principal` is null only when a host adds `tools/call`
   * to `publicMethods`.
   */
  context: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  /**
   * Opt-in metrics hook. Pass any function to receive tool results and auth
   * denials (bad token, missing scope, query-string token), a refused protocol
   * version header, plus the 500 path when a host port throws. Other protocol errors
   * (malformed JSON, bad `jsonrpc`, oversized body, batch, a 2026-07-28 `_meta` or header
   * fault) are not audited. Omit it and the library stays silent — no stdout, no store.
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
   *
   * `"strict"` hides the same way and also answers a `tools/call` for such a tool as an unknown
   * tool (JSON-RPC -32602), not 403, so a caller cannot tell a hidden tool from a missing one.
   * The denial is still audited as `missing_scope`.
   */
  hideToolsOutsideScope?: boolean | "strict";
  /**
   * MCP Apps: the UI documents tools point at with `ToolDef.ui`. Setting it
   * (or any tool `ui`) adds `resources/list` + `resources/read` and the
   * `resources` capability; leave it out and the server answers exactly as before.
   * A resource is readable by a principal who may call at least one tool that
   * references it. See `docs/mcp-apps.md`.
   */
  uiResources?: UiResource[];
  /**
   * General resources: fixed URIs served by `resources/list` and `resources/read` next to any `uiResources`.
   * A resource is listed and read only by a principal its `scope` and `allow` admit, and its `read` runs
   * once per authorized read, never for a list. See `docs/resources.md`.
   */
  resources?: ResourceDef<TCtx>[];
  /**
   * @experimental Skills over MCP (`io.modelcontextprotocol/skills`): text skills served by `skills/list`,
   * `skills/get` and `resources/read` at `skill://<name>/...`, each gated by its own `scope` and `allow`.
   * Off unless set: without it every response is as before. A skill is data and is never run. See `docs/skills.md`.
   */
  skills?: SkillDef[];
};

/** `McpHandlerOptions` after `createMcpHandler` resolved its defaults. */
export type ResolvedMcpHandlerOptions<TCtx> = McpHandlerOptions<TCtx> & {
  publicMethods: Set<string>;
  /** What a request that carries the 2026-07-28 header may call without authentication. */
  modernPublicMethods: Set<string>;
  /** Built and validated once by `createMcpHandler`; `undefined` when the server has no resources at all. */
  resourceCatalog?: ResourceCatalog<TCtx> | undefined;
  /** Built and validated once by `createMcpHandler`; `undefined` when no skill is registered. */
  skillIndex?: SkillIndex | undefined;
};

/** Wraps a method's success result in its JSON-RPC response; errors never pass through it. */
export type ResultWriter = (id: JsonRpcId, result: object) => Response;

export type RpcMethodHandler<TCtx> = (input: {
  req: Request;
  body: JsonRpcRequest;
  id: JsonRpcId;
  principal: Principal | null;
  options: ResolvedMcpHandlerOptions<TCtx>;
  /** Request start, for denial-path audit timing — see `dispatchRpc`. */
  startedAt: number;
  /** Writes a success result: plain for older protocol versions, with 2026-07-28 fields otherwise. */
  respond: ResultWriter;
  /** The extensions the client declared on this request; `undefined` on a request that is not 2026-07-28. */
  client?: ClientContext | undefined;
}) => Promise<Response>;
