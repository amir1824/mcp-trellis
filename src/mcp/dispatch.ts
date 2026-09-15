import { rejectQueryToken } from "../auth/bearer.js";
import { BodyTooLargeError, DEFAULT_MCP_BODY_LIMIT, readBoundedText } from "../http/body.js";
import {
  emptyResponse,
  errorReason,
  INTERNAL_ERROR,
  jsonResponse,
  methodNotAllowed,
  optionsResponse,
} from "../http/http.js";
import { reflectCorsIfNeeded, requestOriginDenied } from "../http/origins.js";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_PARSE_ERROR,
  JSONRPC_PAYLOAD_TOO_LARGE,
  protocolVersionHeaderError,
  rpcError,
  validateJsonRpcEnvelope,
} from "./jsonrpc.js";
import {
  DEFAULT_PUBLIC_METHODS,
  DENIAL_REASONS,
  isNotification,
  type McpHandlerOptions,
  type ResolvedMcpHandlerOptions,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "./methods.js";
import { dispatchRpc } from "./rpc-handlers.js";

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
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return jsonResponse({
        data: rpcError(null, JSONRPC_PAYLOAD_TOO_LARGE, "Payload too large"),
        status: 413,
      });
    }
    return jsonResponse({ data: rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), status: 400 });
  }
  try {
    return JSON.parse(text);
  } catch {
    return jsonResponse({ data: rpcError(null, JSONRPC_PARSE_ERROR, "Parse error"), status: 400 });
  }
};

/** Transport-level denial: no JSON-RPC method has been parsed yet. */
const auditDenial = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  error: string,
  startedAt: number,
): Promise<void> =>
  safeAudit(options, { method: "", ok: false, error, durationMs: Date.now() - startedAt });

const denyQueryStringToken = async <TCtx>(
  request: Request,
  options: McpHandlerOptions<TCtx>,
  startedAt: number,
): Promise<Response | null> => {
  if (rejectQueryToken(new URL(request.url))) {
    await auditDenial(options, DENIAL_REASONS.queryStringToken, startedAt);
    return unauthorized(
      resolveWwwAuthenticate(options, request),
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
  const denied = await denyQueryStringToken(request, options, startedAt);
  if (denied) return denied;
  if (!request.headers.get("authorization")) {
    await auditDenial(options, DENIAL_REASONS.unauthorized, startedAt);
    return unauthorized(resolveWwwAuthenticate(options, request));
  }
  return methodNotAllowed("Use POST for MCP");
};

const handlePost = async <TCtx>(
  request: Request,
  options: ResolvedMcpHandlerOptions<TCtx>,
  startedAt: number,
): Promise<Response> => {
  const denied = await denyQueryStringToken(request, options, startedAt);
  if (denied) return denied;

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  const envelope = validateJsonRpcEnvelope(parsed);
  if (envelope instanceof Response) return envelope;

  const versionError = protocolVersionHeaderError(request, envelope);
  if (versionError) return versionError;

  if (isNotification(envelope)) return emptyResponse(202);
  return dispatchRpc({ req: request, body: envelope, options, startedAt });
};

type HttpMethodHandler = (request: Request, startedAt: number) => Promise<Response> | Response;

export const createMcpHandler = <TCtx>(handlerOptions: McpHandlerOptions<TCtx>): McpHandler => {
  const options: ResolvedMcpHandlerOptions<TCtx> = {
    ...handlerOptions,
    publicMethods: handlerOptions.publicMethods ?? DEFAULT_PUBLIC_METHODS,
  };

  const HTTP_METHODS: Record<string, HttpMethodHandler> = {
    OPTIONS: () => optionsResponse(),
    GET: (request, startedAt) => handleGet(request, options, startedAt),
    POST: (request, startedAt) => handlePost(request, options, startedAt),
  };

  return {
    fetch: async (request: Request): Promise<Response> => {
      const startedAt = Date.now();
      try {
        const originDenied = await requestOriginDenied(request, options.allowedRequestOrigins, () =>
          auditDenial(options, DENIAL_REASONS.originNotAllowed, startedAt),
        );
        if (originDenied) return originDenied;

        const handler = HTTP_METHODS[request.method];
        const response = await (handler ? handler(request, startedAt) : methodNotAllowed());
        return reflectCorsIfNeeded(response, request, options.allowedRequestOrigins);
      } catch (caught) {
        // A host port (authenticate/context/audit) threw. `fetch` must never
        // reject — the caller gets an honest 500, not an unhandled rejection
        // whose shape depends on which runtime is hosting this.
        await auditDenial(options, errorReason(caught) || INTERNAL_ERROR, startedAt);
        return reflectCorsIfNeeded(
          jsonResponse({
            data: rpcError(null, JSONRPC_INTERNAL_ERROR, "Internal error"),
            status: 500,
          }),
          request,
          options.allowedRequestOrigins,
        );
      }
    },
  };
};
