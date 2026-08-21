import { type WwwAuthenticateOptions, wwwAuthenticateHeader } from "./auth/bearer.js";
import { emptyResponse, jsonResponse } from "./http.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_UNAUTHORIZED,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
import { pickProtocolVersion } from "./protocol.js";
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
   * Opt-in metrics hook. Pass any function to receive each tool result and
   * every denial (bad token, missing scope, query-string token). Omit it and
   * the library stays silent — no stdout, no store. Do what you want with
   * `entry` (DB, APM, admin UI). Throwing never fails the request, and
   * neither does hanging — see `McpHandlerOptions.auditTimeoutMs`.
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
};

const DEFAULT_AUDIT_TIMEOUT_MS = 1000;

export const DEFAULT_PUBLIC_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "initialized",
]);

const NOTIFICATION_PREDICATES: Array<(body: JsonRpcRequest) => boolean> = [
  (body) => typeof body.method === "string" && body.method.startsWith("notifications/"),
  (body) => body.method === "initialized",
  (body) => body.id === undefined && body.method === undefined && "result" in body,
];

export const isNotification = (body: JsonRpcRequest): boolean =>
  NOTIFICATION_PREDICATES.some((predicate) => predicate(body));

export const resolveWww = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  req: Request,
): WwwAuthenticateOptions =>
  typeof options.wwwAuthenticate === "function"
    ? options.wwwAuthenticate(req)
    : options.wwwAuthenticate;

/**
 * `id` defaults to `null` for the transport-level call sites in
 * `dispatch.ts` — a body hasn't been parsed yet there, so there's no real
 * id to echo. Call sites past that point (inside `dispatchRpc` and the
 * method handlers) have one and must pass it, or a client correlating
 * responses by id sees `null` on every 401 regardless of what it sent.
 */
export const unauthorized = (
  www: WwwAuthenticateOptions,
  message = "Unauthorized",
  id: JsonRpcId = null,
): Response =>
  jsonResponse(rpcError(id, JSONRPC_UNAUTHORIZED, message), 401, {
    "WWW-Authenticate": wwwAuthenticateHeader(www),
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

type MethodFn<TCtx> = (input: {
  req: Request;
  body: JsonRpcRequest;
  id: JsonRpcId;
  principal: Principal | null;
  ctx: TCtx;
  options: McpHandlerOptions<TCtx>;
  /** Request start, for denial-path audit timing — see `dispatchRpc`. */
  startedAt: number;
}) => Promise<Response>;

const METHODS = {
  initialize: async ({ id, body, options }) =>
    jsonResponse(
      rpcResult(id, {
        protocolVersion: pickProtocolVersion(body.params),
        capabilities: { tools: {} },
        serverInfo: options.serverInfo,
        instructions: options.instructions ?? "",
      }),
    ),

  ping: async ({ id }) => jsonResponse(rpcResult(id, {})),

  "tools/list": async ({ id, options }) =>
    jsonResponse(rpcResult(id, { tools: options.registry.list() })),

  "tools/call": async ({ req, body, id, principal, ctx, options, startedAt }) => {
    const params = body.params ?? {};
    const name = String(params.name ?? "");
    const rawArgs = params.arguments;
    const args =
      rawArgs !== null && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    const tool = options.registry.get(name);
    if (tool?.scope && (!principal || !hasScope(principal, tool.scope))) {
      await safeAudit(options, {
        method: "tools/call",
        tool: name,
        principalId: principal?.id,
        ok: false,
        error: "missing_scope",
        durationMs: Date.now() - startedAt,
      });
      return unauthorized(resolveWww(options, req), `Missing scope: ${tool.scope}`, id);
    }

    const started = Date.now();
    const result = await options.registry.call(name, ctx, args);
    await safeAudit(options, {
      method: "tools/call",
      tool: name,
      principalId: principal?.id,
      ok: !result.isError,
      error: result.isError ? result.content[0]?.text : undefined,
      durationMs: Date.now() - started,
    });
    return jsonResponse(rpcResult(id, result));
  },
} as const satisfies Record<string, MethodFn<unknown>>;

export const dispatchRpc = async <TCtx>(input: {
  req: Request;
  body: JsonRpcRequest;
  options: McpHandlerOptions<TCtx>;
  publicMethods: Set<string>;
  /** Request start (captured in `createMcpHandler.fetch`), for denial-path audit timing. */
  startedAt: number;
}): Promise<Response> => {
  const { req, body, options, publicMethods, startedAt } = input;
  const method = body.method ?? "";
  // Notifications omit `id`; explicit null is a valid request id (JSON-RPC).
  const id = body.id === undefined ? null : body.id;
  const toolName = method === "tools/call" ? String(body.params?.name ?? "") : undefined;

  const isPublic = publicMethods.has(method) || method.startsWith("notifications/");
  let principal: Principal | null = null;

  if (!isPublic) {
    principal = await options.ports.authenticate(req, method, toolName);
    if (!principal) {
      await safeAudit(options, {
        method,
        tool: toolName,
        ok: false,
        error: "unauthorized",
        durationMs: Date.now() - startedAt,
      });
      return unauthorized(resolveWww(options, req), undefined, id);
    }
  }

  const handler = (METHODS as Record<string, MethodFn<TCtx> | undefined>)[method];
  if (!handler) {
    if (body.id === undefined) return emptyResponse(202);
    return jsonResponse(rpcError(body.id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`));
  }

  const ctx = await options.ports.context(req, principal);
  return handler({ req, body, id, principal, ctx, options, startedAt });
};
