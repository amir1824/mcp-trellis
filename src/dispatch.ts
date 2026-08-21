import { rejectQueryToken } from "./auth/bearer.js";
import { BodyTooLargeError, DEFAULT_MCP_BODY_LIMIT, readBoundedText } from "./body.js";
import {
  emptyResponse,
  INTERNAL_ERROR,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from "./http.js";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  JSONRPC_PAYLOAD_TOO_LARGE,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
} from "./jsonrpc.js";
import {
  DEFAULT_PUBLIC_METHODS,
  dispatchRpc,
  isNotification,
  type McpHandlerOptions,
  resolveWww,
  safeAudit,
  unauthorized,
} from "./methods.js";
import { PROTOCOL_VERSIONS } from "./protocol.js";

export type {
  AuditEntry,
  McpHandlerOptions,
  McpPorts,
  Principal,
  ServerInfo,
} from "./methods.js";

export type McpHandler = {
  fetch: (request: Request) => Promise<Response>;
};

const parseBody = async (request: Request): Promise<Response | unknown> => {
  let text: string;
  try {
    text = await readBoundedText(request, DEFAULT_MCP_BODY_LIMIT);
  } catch (exc) {
    if (exc instanceof BodyTooLargeError) {
      return jsonResponse(rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"), 413);
    }
    return jsonResponse(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    return jsonResponse(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), 400);
  }
};

/** Transport-level denial: no JSON-RPC method has been parsed yet. */
const auditDenial = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  error: string,
  startedAt: number,
): Promise<void> =>
  safeAudit(options, { method: "", ok: false, error, durationMs: Date.now() - startedAt });

const guardPost = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
  startedAt: number,
): Promise<Response | null> => {
  if (rejectQueryToken(new URL(request.url))) {
    await auditDenial(options, "query_string_token", startedAt);
    return unauthorized(
      resolveWww(options, request),
      "Token in query string is rejected. Use Authorization Bearer.",
    );
  }
  return null;
};

const handleGet = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
  startedAt: number,
): Promise<Response> => {
  if (rejectQueryToken(new URL(request.url))) {
    await auditDenial(options, "query_string_token", startedAt);
    return jsonResponse(
      {
        error: "Pass token via Authorization: Bearer header, not query string",
      },
      400,
    );
  }
  if (!request.headers.get("authorization")) {
    await auditDenial(options, "unauthorized", startedAt);
    return unauthorized(resolveWww(options, request));
  }
  return methodNotAllowed("Use POST for MCP");
};

/**
 * RFC-shaped JSON-RPC id extraction for an error response before
 * `dispatchRpc`'s own normalization runs — `undefined` (omitted, as on a
 * notification) becomes `null`; anything else is echoed as-is, matching
 * `dispatchRpc`'s rule so a client sees the same id either way.
 */
const errorId = (msg: JsonRpcRequest): JsonRpcId => (msg.id === undefined ? null : msg.id);

/**
 * The 2025-06-18 spec requires `MCP-Protocol-Version` on every request past
 * `initialize` (which is what negotiates it in the first place — the
 * client can't have the header yet). Unknown/unsupported → 400. Missing →
 * assume `2025-03-26` per the spec's own backwards-compatibility rule for
 * the header specifically (not the same default `initialize` falls back
 * to — see `protocol.ts`).
 */
const protocolVersionHeaderError = (request: Request, msg: JsonRpcRequest): Response | null => {
  if (msg.method === "initialize") return null;
  const header = request.headers.get("MCP-Protocol-Version");
  if (!header || PROTOCOL_VERSIONS.has(header)) return null;
  return jsonResponse(
    rpcError(errorId(msg), JSONRPC_INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${header}`),
    400,
  );
};

const handlePost = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
  publicMethods: Set<string>,
  startedAt: number,
): Promise<Response> => {
  const denied = await guardPost(request, options, startedAt);
  if (denied) return denied;

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  if (Array.isArray(parsed)) {
    return jsonResponse(
      rpcError(null, JSONRPC_INVALID_REQUEST, "Batch requests not supported"),
      400,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return jsonResponse(rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), 400);
  }

  const msg = parsed as JsonRpcRequest;
  if (msg.jsonrpc !== "2.0") {
    return jsonResponse(
      rpcError(errorId(msg), JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0"'),
      400,
    );
  }

  const versionError = protocolVersionHeaderError(request, msg);
  if (versionError) return versionError;

  if (isNotification(msg)) return emptyResponse(202);
  return dispatchRpc({ req: request, body: msg, options, publicMethods, startedAt });
};

type HttpMethodFn = (request: Request, startedAt: number) => Promise<Response> | Response;

export const createMcpHandler = <TCtx>(options: McpHandlerOptions<TCtx>): McpHandler => {
  const publicMethods = options.publicMethods ?? DEFAULT_PUBLIC_METHODS;

  const HTTP_METHODS: Record<string, HttpMethodFn> = {
    OPTIONS: () => optionsResponse(),
    GET: (request, startedAt) => handleGet(request, options, startedAt),
    POST: (request, startedAt) => handlePost(request, options, publicMethods, startedAt),
  };

  return {
    fetch: async (request: Request): Promise<Response> => {
      const startedAt = Date.now();
      try {
        const handler = HTTP_METHODS[request.method];
        return await (handler ? handler(request, startedAt) : methodNotAllowed());
      } catch (exc) {
        // A host port (authenticate/context/audit) threw. `fetch` must never
        // reject — the caller gets an honest 500, not an unhandled rejection
        // whose shape depends on which runtime is hosting this.
        const error = exc instanceof Error && exc.message ? exc.message : INTERNAL_ERROR;
        await auditDenial(options, error, startedAt);
        return jsonResponse(rpcError(null, JSONRPC_INTERNAL_ERROR, "Internal error"), 500);
      }
    },
  };
};
