import { type WwwAuthenticateOptions, wwwAuthenticateHeader } from "./auth/bearer.js";
import { jsonResponse } from "./http.js";
import { JSONRPC_UNAUTHORIZED, type JsonRpcId, type JsonRpcRequest, rpcError } from "./jsonrpc.js";
import type { ToolRegistry } from "./registry.js";

export type Principal = {
  id: string;
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
};

const DEFAULT_AUDIT_TIMEOUT_MS = 1000;

export const DEFAULT_PUBLIC_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "initialized",
]);

/**
 * JSON-RPC 2.0: a notification omits `id` (no response). MCP also treats
 * `notifications/*` and legacy `initialized` as notifications even when an
 * `id` is present. Orphan result-shaped bodies (no method/id) get 202 too.
 */
export const isNotification = (body: JsonRpcRequest): boolean => {
  if (body.id === undefined) {
    return typeof body.method === "string" || (body.method === undefined && "result" in body);
  }
  return (
    (typeof body.method === "string" && body.method.startsWith("notifications/")) ||
    body.method === "initialized"
  );
};

export const resolveWwwAuthenticate = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  request: Request,
): WwwAuthenticateOptions =>
  typeof options.wwwAuthenticate === "function"
    ? options.wwwAuthenticate(request)
    : options.wwwAuthenticate;

/**
 * `id` defaults to `null` for the transport-level call sites in
 * `dispatch.ts` — a body hasn't been parsed yet there, so there's no real
 * id to echo. Call sites past that point (inside `dispatchRpc` and the
 * method handlers) have one and must pass it, or a client correlating
 * responses by id sees `null` on every 401 regardless of what it sent.
 */
export const unauthorized = (
  wwwAuthenticate: WwwAuthenticateOptions,
  message = "Unauthorized",
  id: JsonRpcId = null,
): Response =>
  jsonResponse({
    data: rpcError(id, JSONRPC_UNAUTHORIZED, message),
    status: 401,
    headers: { "WWW-Authenticate": wwwAuthenticateHeader(wwwAuthenticate) },
  });

/**
 * Invoke the audit metrics hook, swallowing any failure and racing it
 * against `auditTimeoutMs` so a hanging sink can't stall the response
 * either — "can't fail a request" was already true; this adds "can't
 * delay one" past a bound. The audit call keeps running in the background
 * if the timer wins; its own `catch` below means it can never surface as
 * an unhandled rejection whenever it does finish.
 */
export const safeAudit = async <TCtx>(
  options: McpHandlerOptions<TCtx>,
  entry: AuditEntry,
): Promise<void> => {
  const audit = options.ports.audit;
  if (!audit) return;

  const settled = (async () => {
    try {
      await audit(entry);
    } catch {
      // Intentionally ignored.
    }
  })();

  const timeoutMs = options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
  await Promise.race([settled, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
};

export const hasScope = (principal: Principal, scope: string | undefined): boolean => {
  if (!scope) return true;
  return principal.scopes.includes(scope) || principal.scopes.includes("*");
};
