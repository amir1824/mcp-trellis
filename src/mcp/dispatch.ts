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
import { ownValue } from "../util/own.js";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_PARSE_ERROR,
  rpcError,
  validateJsonRpcEnvelope,
} from "./jsonrpc.js";
import { profileFor, type VersionProfile } from "./modern/profile.js";
import { resolveModernPublicMethods } from "./modern/request.js";
import {
  DEFAULT_PUBLIC_METHODS,
  DENIAL_REASONS,
  isNotification,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "./request-policy.js";
import { buildResourceCatalog } from "./resources/catalog.js";
import { dispatchRpc } from "./rpc-handlers.js";
import type { McpHandlerOptions, ResolvedMcpHandlerOptions } from "./types.js";

export type {
  AuditEntry,
  McpHandlerOptions,
  McpPorts,
  Principal,
  ServerInfo,
} from "./types.js";

export type McpHandler = {
  fetch: (request: Request) => Promise<Response>;
};

const parseBody = async (
  request: Request,
  profile: VersionProfile,
): Promise<Response | unknown> => {
  let text: string;
  try {
    text = await readBoundedText(request, DEFAULT_MCP_BODY_LIMIT);
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) return profile.tooLarge();
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

  // The header names the version and arrives before the body, so the size error can be the right one.
  const profile = profileFor(request);
  const parsed = await parseBody(request, profile);
  if (parsed instanceof Response) return parsed;

  const envelope = validateJsonRpcEnvelope(parsed);
  if (envelope instanceof Response) return envelope;

  const versionError = profile.versionError(request, envelope);
  if (versionError) return versionError;

  if (isNotification(envelope)) return emptyResponse(202);
  const requestError = profile.requestError(request, envelope);
  if (requestError) return requestError;
  return dispatchRpc({ req: request, body: envelope, options, startedAt, profile });
};

/** 2026-07-28 clients send `Mcp-Method` and `Mcp-Name`, so a browser preflight must allow them. */
const MCP_PREFLIGHT_ALLOWED_HEADERS =
  "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name";

const mcpPreflight = (): Response => {
  const response = optionsResponse();
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Headers", MCP_PREFLIGHT_ALLOWED_HEADERS);
  return new Response(null, { status: response.status, headers });
};

type HttpMethodHandler = (request: Request, startedAt: number) => Promise<Response> | Response;

export const createMcpHandler = <TCtx>(handlerOptions: McpHandlerOptions<TCtx>): McpHandler => {
  const options: ResolvedMcpHandlerOptions<TCtx> = {
    ...handlerOptions,
    publicMethods: handlerOptions.publicMethods ?? DEFAULT_PUBLIC_METHODS,
    modernPublicMethods: resolveModernPublicMethods(handlerOptions.publicMethods),
    resourceCatalog: buildResourceCatalog(handlerOptions.registry, handlerOptions),
  };

  const HTTP_METHODS: Record<string, HttpMethodHandler> = {
    OPTIONS: () => mcpPreflight(),
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

        const handler = ownValue(HTTP_METHODS, request.method);
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
