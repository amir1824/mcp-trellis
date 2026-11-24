/** JSON-RPC method handlers and authenticated dispatch. */

import { jsonResponse } from "../http/http.js";
import { clipText } from "../util/clip.js";
import { ownValue } from "../util/own.js";
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcRequest,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
import { pickProtocolVersion } from "./protocol.js";
import {
  authFailureChallenge,
  DENIAL_REASONS,
  insufficientScope,
  mayUse,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "./request-policy.js";
import {
  auditToolCall,
  invalidArgumentsResponse,
  parseToolCallArgs,
  shownName,
  type ToolCallDenialInput,
} from "./tools/call-args.js";
import { firstText } from "./tools/content.js";
import type {
  McpHandlerOptions,
  Principal,
  ResolvedMcpHandlerOptions,
  RpcMethodHandler,
} from "./types.js";
import { UI_METHODS } from "./ui/methods.js";

/** Longest tool-failure text copied into an audit entry — it is tool- or caller-supplied. */
const MAX_AUDIT_ERROR_LENGTH = 1000;

const auditText = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : clipText(text, MAX_AUDIT_ERROR_LENGTH, "…");

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
    tool: shownName(input.name),
    ok: false,
    error: DENIAL_REASONS.unknownTool,
  });
  return jsonResponse({
    data: rpcError(input.id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${shownName(input.name)}`),
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

const CORE_METHODS = {
  initialize: async ({ id, body, options }) =>
    jsonResponse({
      data: rpcResult(id, {
        protocolVersion: pickProtocolVersion(body.params),
        capabilities: options.uiRegistry ? { tools: {}, resources: {} } : { tools: {} },
        serverInfo: options.serverInfo,
        instructions: options.instructions ?? "",
      }),
    }),

  ping: async ({ id }) => jsonResponse({ data: rpcResult(id, {}) }),

  "tools/list": async ({ id, options, principal }) => {
    const allowScope = options.hideToolsOutsideScope
      ? (scope: string | null | undefined) => mayUse(principal, scope)
      : undefined;
    return jsonResponse({ data: rpcResult(id, { tools: options.registry.list(allowScope) }) });
  },

  "tools/call": async ({ req, body, id, principal, options, startedAt }) => {
    const parsed = parseToolCallArgs(body);
    if ("error" in parsed) {
      return jsonResponse({ data: rpcError(id, JSONRPC_INVALID_PARAMS, parsed.error) });
    }
    const { name, args } = parsed;

    const tool = options.registry.get(name);
    if (!tool) return unknownToolResponse(options, { name, principal, id, startedAt });
    if (tool.scope && !mayUse(principal, tool.scope)) {
      return missingScopeResponse(req, options, {
        name,
        principal,
        id,
        startedAt,
        scope: tool.scope,
      });
    }

    // After the scope check, so a caller without the scope is told so (403 +
    // step-up challenge), not that its arguments are malformed.
    if (args === null) return invalidArgumentsResponse(options, { name, principal, id, startedAt });

    // Built only for a call that will actually run: `initialize`, `ping`,
    // `tools/list` and denied calls never reach the host's `context` port.
    const ctx = await options.ports.context(req, principal);
    const toolStartedAt = Date.now();
    const result = await options.registry.call(name, ctx, args);
    await auditToolCall(options, {
      tool: name,
      principal,
      ok: !result.isError,
      error: result.isError ? auditText(firstText(result)) : undefined,
      startedAt: toolStartedAt,
    });
    return jsonResponse({ data: rpcResult(id, result) });
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;

/** `resources/*` exist only on a server with a UI: without one they are as unknown as any other method. */
const ALL_METHODS = { ...CORE_METHODS, ...UI_METHODS };

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
  const toolName =
    method === "tools/call"
      ? typeof body.params?.name === "string"
        ? body.params.name
        : ""
      : undefined;

  // Notifications (including every `notifications/*`) already got 202 in `handlePost`.
  const isPublic = options.publicMethods.has(method);
  let principal: Principal | null = null;

  if (!isPublic) {
    principal = await options.ports.authenticate(req, method, toolName);
    if (!principal) {
      await safeAudit(options, {
        method,
        tool: toolName === undefined ? undefined : shownName(toolName),
        ok: false,
        error: DENIAL_REASONS.unauthorized,
        durationMs: Date.now() - startedAt,
      });
      return unauthorized(authFailureChallenge(options, req), undefined, id);
    }
  }

  // A client-selected method name must not reach Object.prototype (e.g.
  // `toString` or `__proto__`): only own entries in METHODS are RPC methods.
  const methods = options.uiRegistry ? ALL_METHODS : CORE_METHODS;
  const handler = ownValue(methods as Record<string, RpcMethodHandler<TCtx>>, method);
  if (!handler) {
    return jsonResponse({
      data: rpcError(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    });
  }

  return handler({ req, body, id, principal, options, startedAt });
};
