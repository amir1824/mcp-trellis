/** JSON-RPC method handlers and authenticated dispatch. */

import { jsonResponse } from "../http/http.js";
import { isJsonObject } from "../util/json.js";
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
import {
  type AuditEntry,
  DENIAL_REASONS,
  hasScope,
  insufficientScope,
  type McpHandlerOptions,
  type Principal,
  type ResolvedMcpHandlerOptions,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "./methods.js";
import { pickProtocolVersion } from "./protocol.js";

/** The one shape every "tools/call" outcome — unknown tool, missing scope, or a real call — audits. */
const auditToolCall = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  input: Pick<AuditEntry, "tool" | "ok" | "error"> & {
    principal: Principal | null;
    startedAt: number;
  },
): Promise<void> =>
  safeAudit(options, {
    method: "tools/call",
    tool: input.tool,
    principalId: input.principal?.id,
    ok: input.ok,
    error: input.error,
    durationMs: Date.now() - input.startedAt,
  });

const parseToolCallArgs = (
  body: JsonRpcRequest,
): { name: string; args: Record<string, unknown> } => {
  const params = body.params ?? {};
  const name = String(params.name ?? "");
  const args = isJsonObject(params.arguments) ? params.arguments : {};
  return { name, args };
};

type ToolCallDenialInput = {
  name: string;
  principal: Principal | null;
  id: JsonRpcId;
  startedAt: number;
};

/**
 * A name that doesn't refer to any registered tool is a malformed request,
 * not a tool execution outcome — MCP distinguishes protocol errors (a
 * standard JSON-RPC error response) from a tool's own isError: true result,
 * and "no such tool" belongs to the former. `ToolRegistry.call`'s own
 * "Unknown tool: …" text-result fallback stays as is for direct callers of
 * that API outside this dispatch.
 */
const unknownToolResponse = async <TCtx>(
  options: McpHandlerOptions<TCtx>,
  input: ToolCallDenialInput,
): Promise<Response> => {
  await auditToolCall(options, {
    ...input,
    tool: input.name,
    ok: false,
    error: DENIAL_REASONS.unknownTool,
  });
  return jsonResponse({
    data: rpcError(input.id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${input.name}`),
  });
};

const missingScopeResponse = async <TCtx>(
  req: Request,
  options: McpHandlerOptions<TCtx>,
  input: ToolCallDenialInput & { scope: string },
): Promise<Response> => {
  await auditToolCall(options, {
    ...input,
    tool: input.name,
    ok: false,
    error: DENIAL_REASONS.missingScope,
  });
  const wwwAuthenticate = resolveWwwAuthenticate(options, req);
  // No principal at all (only reachable when a host adds "tools/call" to
  // `publicMethods`) → 401, nothing was presented to authenticate with.
  // A principal that authenticated but lacks the tool's scope → 403
  // insufficient_scope (RFC 6750 §3.1) — see `insufficientScope`'s doc.
  return input.principal
    ? insufficientScope(wwwAuthenticate, input.scope, input.id)
    : unauthorized(wwwAuthenticate, `Missing scope: ${input.scope}`, input.id);
};

type RpcMethodHandler<TCtx> = (input: {
  req: Request;
  body: JsonRpcRequest;
  id: JsonRpcId;
  principal: Principal | null;
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

  "tools/list": async ({ id, options, principal }) => {
    const allowScope = options.hideToolsOutsideScope
      ? (scope: string | null | undefined) =>
          !scope || (principal ? hasScope(principal, scope) : false)
      : undefined;
    return jsonResponse({ data: rpcResult(id, { tools: options.registry.list(allowScope) }) });
  },

  "tools/call": async ({ req, body, id, principal, options, startedAt }) => {
    const { name, args } = parseToolCallArgs(body);

    const tool = options.registry.get(name);
    if (!tool) return unknownToolResponse(options, { name, principal, id, startedAt });
    if (tool.scope && (!principal || !hasScope(principal, tool.scope))) {
      return missingScopeResponse(req, options, {
        name,
        principal,
        id,
        startedAt,
        scope: tool.scope,
      });
    }

    // Built only for a call that will actually run: `initialize`, `ping`,
    // `tools/list` and denied calls never reach the host's `context` port.
    const ctx = await options.ports.context(req, principal);
    const toolStartedAt = Date.now();
    const result = await options.registry.call(name, ctx, args);
    await auditToolCall(options, {
      tool: name,
      principal,
      ok: !result.isError,
      error: result.isError ? result.content[0]?.text : undefined,
      startedAt: toolStartedAt,
    });
    return jsonResponse({ data: rpcResult(id, result) });
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;

export const dispatchRpc = async <TCtx>(input: {
  req: Request;
  body: JsonRpcRequest;
  options: ResolvedMcpHandlerOptions<TCtx>;
  /** Request start (captured in `createMcpHandler.fetch`), for denial-path audit timing. */
  startedAt: number;
}): Promise<Response> => {
  const { req, body, options, startedAt } = input;
  // Shape-validated in `handlePost` before routing — method is a non-empty string.
  const method = typeof body.method === "string" ? body.method : "";
  // Notifications omit `id`; explicit null is a valid request id (JSON-RPC).
  const id = body.id === undefined ? null : body.id;
  const toolName = method === "tools/call" ? String(body.params?.name ?? "") : undefined;

  // Notifications (including every `notifications/*`) already got 202 in `handlePost`.
  const isPublic = options.publicMethods.has(method);
  let principal: Principal | null = null;

  if (!isPublic) {
    principal = await options.ports.authenticate(req, method, toolName);
    if (!principal) {
      await safeAudit(options, {
        method,
        tool: toolName,
        ok: false,
        error: DENIAL_REASONS.unauthorized,
        durationMs: Date.now() - startedAt,
      });
      return unauthorized(resolveWwwAuthenticate(options, req), undefined, id);
    }
  }

  const handler = (METHODS as Record<string, RpcMethodHandler<TCtx> | undefined>)[method];
  if (!handler) {
    return jsonResponse({
      data: rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    });
  }

  return handler({ req, body, id, principal, options, startedAt });
};
