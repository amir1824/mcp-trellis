import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_PARSE_ERROR,
  type JsonRpcRequest,
  rpcError,
} from "./jsonrpc.js";
import {
  INTERNAL_ERROR,
  emptyResponse,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from "./http.js";
import { rejectQueryToken } from "./auth/bearer.js";
import {
  DEFAULT_PUBLIC_METHODS,
  dispatchRpc,
  isNotification,
  resolveWww,
  safeAudit,
  unauthorized,
  type McpHandlerOptions,
} from "./methods.js";

export type {
  Principal,
  AuditEntry,
  McpPorts,
  ServerInfo,
  McpHandlerOptions,
} from "./methods.js";

export type McpHandler = {
  fetch: (request: Request) => Promise<Response>;
};

const parseBody = async (request: Request): Promise<Response | unknown> => {
  try {
    return await request.json();
  } catch {
    return jsonResponse(
      rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"),
      400,
    );
  }
};

/** Transport-level denial: no JSON-RPC method has been parsed yet. */
const auditDenial = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  error: string,
): Promise<void> =>
  safeAudit(options, { method: "", ok: false, error, durationMs: 0 });

const guardPost = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
): Promise<Response | null> => {
  if (rejectQueryToken(new URL(request.url))) {
    await auditDenial(options, "query_string_token");
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
): Promise<Response> => {
  if (rejectQueryToken(new URL(request.url))) {
    await auditDenial(options, "query_string_token");
    return jsonResponse(
      {
        error:
          "Pass token via Authorization: Bearer header, not query string",
      },
      400,
    );
  }
  if (!request.headers.get("authorization")) {
    await auditDenial(options, "unauthorized");
    return unauthorized(resolveWww(options, request));
  }
  return methodNotAllowed("Use POST for MCP");
};

const handlePost = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
  publicMethods: Set<string>,
): Promise<Response> => {
  const denied = await guardPost(request, options);
  if (denied) return denied;

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  if (Array.isArray(parsed)) {
    return jsonResponse(
      rpcError(
        null,
        JSONRPC_INVALID_REQUEST,
        "Batch requests not supported",
      ),
      400,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    return jsonResponse(
      rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"),
      400,
    );
  }

  const msg = parsed as JsonRpcRequest;
  if (isNotification(msg)) return emptyResponse(202);
  return dispatchRpc({ req: request, body: msg, options, publicMethods });
};

type HttpMethodFn<TCtx> = (
  request: Request,
  options: McpHandlerOptions<TCtx>,
  publicMethods: Set<string>,
) => Promise<Response> | Response;

export const createMcpHandler = <TCtx>(
  options: McpHandlerOptions<TCtx>,
): McpHandler => {
  const publicMethods = options.publicMethods ?? DEFAULT_PUBLIC_METHODS;

  const HTTP_METHODS: Record<string, HttpMethodFn<TCtx>> = {
    OPTIONS: () => optionsResponse(),
    GET: (request) => handleGet(request, options),
    POST: (request) => handlePost(request, options, publicMethods),
  };

  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        const handler = HTTP_METHODS[request.method];
        return await (handler
          ? handler(request, options, publicMethods)
          : methodNotAllowed());
      } catch (exc) {
        // A host port (authenticate/context/audit) threw. `fetch` must never
        // reject — the caller gets an honest 500, not an unhandled rejection
        // whose shape depends on which runtime is hosting this.
        const error =
          exc instanceof Error && exc.message ? exc.message : INTERNAL_ERROR;
        await auditDenial(options, error);
        return jsonResponse(
          rpcError(null, JSONRPC_INTERNAL_ERROR, "Internal error"),
          500,
        );
      }
    },
  };
};
