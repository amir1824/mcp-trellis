/** JSON-RPC method handlers and authenticated dispatch. */

import { jsonResponse } from "./http.js";
import {
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
import {
  hasScope,
  type McpHandlerOptions,
  type Principal,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "./methods.js";
import { pickProtocolVersion } from "./protocol.js";

type RpcMethodHandler<TCtx> = (input: {
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
    jsonResponse({
      data: rpcResult(id, {
        protocolVersion: pickProtocolVersion(body.params),
        capabilities: { tools: {} },
        serverInfo: options.serverInfo,
        instructions: options.instructions ?? "",
      }),
    }),

  ping: async ({ id }) => jsonResponse({ data: rpcResult(id, {}) }),

  "tools/list": async ({ id, options }) =>
    jsonResponse({ data: rpcResult(id, { tools: options.registry.list() }) }),

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
      return unauthorized(resolveWwwAuthenticate(options, req), `Missing scope: ${tool.scope}`, id);
    }

    const toolStartedAt = Date.now();
    const result = await options.registry.call(name, ctx, args);
    await safeAudit(options, {
      method: "tools/call",
      tool: name,
      principalId: principal?.id,
      ok: !result.isError,
      error: result.isError ? result.content[0]?.text : undefined,
      durationMs: Date.now() - toolStartedAt,
    });
    return jsonResponse({ data: rpcResult(id, result) });
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;

export const dispatchRpc = async <TCtx>(input: {
  req: Request;
  body: JsonRpcRequest;
  options: McpHandlerOptions<TCtx>;
  publicMethods: Set<string>;
  /** Request start (captured in `createMcpHandler.fetch`), for denial-path audit timing. */
  startedAt: number;
}): Promise<Response> => {
  const { req, body, options, publicMethods, startedAt } = input;
  // Shape-validated in `handlePost` before routing — method is a non-empty string.
  const method = typeof body.method === "string" ? body.method : "";
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
      return unauthorized(resolveWwwAuthenticate(options, req), undefined, id);
    }
  }

  const handler = (METHODS as Record<string, RpcMethodHandler<TCtx> | undefined>)[method];
  // Notifications (omit id / notifications/*) already returned 202 in handlePost.
  if (!handler) {
    return jsonResponse({
      data: rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    });
  }

  const ctx = await options.ports.context(req, principal);
  return handler({ req, body, id, principal, ctx, options, startedAt });
};
