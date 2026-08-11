import {
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_UNAUTHORIZED,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
  rpcResult,
} from "./jsonrpc.js";
import { emptyResponse, jsonResponse } from "./http.js";
import { pickProtocolVersion } from "./protocol.js";
import type { ToolRegistry } from "./registry.js";
import {
  wwwAuthenticateHeader,
  type WwwAuthenticateOptions,
} from "./auth/bearer.js";

export type Principal = {
  id: string;
  scopes: string[];
};

export type AuditEntry = {
  /** JSON-RPC method, or `""` for transport-level rejections made before parsing. */
  method: string;
  tool?: string;
  principalId?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
};

export type McpPorts<TCtx> = {
  authenticate: (
    req: Request,
    method: string,
    tool?: string,
  ) => Promise<Principal | null>;
  context: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  audit?: (entry: AuditEntry) => void | Promise<void>;
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
  wwwAuthenticate:
    | WwwAuthenticateOptions
    | ((req: Request) => WwwAuthenticateOptions);
  /** Methods that skip auth (default: initialize, ping, notifications/*). */
  publicMethods?: Set<string>;
};

export const DEFAULT_PUBLIC_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "initialized",
]);

const NOTIFICATION_PREDICATES: Array<(body: JsonRpcRequest) => boolean> = [
  (body) =>
    typeof body.method === "string" && body.method.startsWith("notifications/"),
  (body) => body.method === "initialized",
  (body) =>
    body.id === undefined && body.method === undefined && "result" in body,
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

export const unauthorized = (
  www: WwwAuthenticateOptions,
  message = "Unauthorized",
): Response =>
  jsonResponse(rpcError(null, JSONRPC_UNAUTHORIZED, message), 401, {
    "WWW-Authenticate": wwwAuthenticateHeader(www),
  });

/**
 * Invoke the audit port, swallowing any failure.
 * Telemetry must never turn a served response into a transport error —
 * this is the only call path to `ports.audit`.
 */
export const safeAudit = async <TCtx>(
  options: McpHandlerOptions<TCtx>,
  entry: AuditEntry,
): Promise<void> => {
  try {
    await options.ports.audit?.(entry);
  } catch {
    // Intentionally ignored.
  }
};

export const hasScope = (
  principal: Principal,
  scope: string | undefined,
): boolean => {
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

  "tools/call": async ({ req, body, id, principal, ctx, options }) => {
    const params = body.params ?? {};
    const name = String(params.name ?? "");
    const rawArgs = params.arguments;
    const args =
      rawArgs !== null &&
      typeof rawArgs === "object" &&
      !Array.isArray(rawArgs)
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
        durationMs: 0,
      });
      return unauthorized(
        resolveWww(options, req),
        `Missing scope: ${tool.scope}`,
      );
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
}): Promise<Response> => {
  const { req, body, options, publicMethods } = input;
  const method = body.method ?? "";
  // Notifications omit `id`; explicit null is a valid request id (JSON-RPC).
  const id = body.id === undefined ? null : body.id;
  const toolName =
    method === "tools/call" ? String(body.params?.name ?? "") : undefined;

  const isPublic =
    publicMethods.has(method) || method.startsWith("notifications/");
  let principal: Principal | null = null;

  if (!isPublic) {
    principal = await options.ports.authenticate(req, method, toolName);
    if (!principal) {
      await safeAudit(options, {
        method,
        tool: toolName,
        ok: false,
        error: "unauthorized",
        durationMs: 0,
      });
      return unauthorized(resolveWww(options, req));
    }
  }

  const handler = (METHODS as Record<string, MethodFn<TCtx> | undefined>)[
    method
  ];
  if (!handler) {
    if (body.id === undefined) return emptyResponse(202);
    return jsonResponse(
      rpcError(body.id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`),
    );
  }

  const ctx = await options.ports.context(req, principal);
  return handler({ req, body, id, principal, ctx, options });
};
