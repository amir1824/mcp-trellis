/** What the MCP handler decides about a request before a method runs: who, which scope, what to audit. */

import { parseBearer, type WwwAuthenticateOptions, wwwAuthenticateHeader } from "../auth/bearer.js";
import { DEFAULT_AUDIT_TIMEOUT_MS, jsonResponse, runAuditBounded } from "../http/http.js";
import {
  JSONRPC_INSUFFICIENT_SCOPE,
  JSONRPC_UNAUTHORIZED,
  type JsonRpcId,
  type JsonRpcRequest,
  rpcError,
} from "./jsonrpc.js";
import type { AuditEntry, McpHandlerOptions, Principal } from "./types.js";

/** `AuditEntry.error` values for requests the handler itself denied. */
export const DENIAL_REASONS = {
  unauthorized: "unauthorized",
  queryStringToken: "query_string_token",
  originNotAllowed: "origin_not_allowed",
  unknownTool: "unknown_tool",
  missingScope: "missing_scope",
  invalidParams: "invalid_params",
} as const;

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
 * The challenge for a request `authenticate` just rejected (RFC 6750 §3.1):
 * `invalid_token` only when a credential was sent, and one code for every
 * reason so the header never tells a token holder why. An `error` the host set
 * in its own `wwwAuthenticate` option is kept.
 */
export const authFailureChallenge = <TCtx>(
  options: McpHandlerOptions<TCtx>,
  request: Request,
): WwwAuthenticateOptions => {
  const challenge = resolveWwwAuthenticate(options, request);
  return parseBearer(request.headers.get("authorization")) === null
    ? challenge
    : { ...challenge, error: challenge.error ?? "invalid_token" };
};

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
 * RFC 6750 §3.1: a request that authenticated but lacks the required scope
 * gets **403**, not 401 — 401 tells the client "authenticate", which a
 * scope-step-up client obeys by re-running the exact same OAuth flow,
 * getting back the exact same scopes, and retrying forever. 403 with
 * `error="insufficient_scope"` says what's actually wrong: re-consent with
 * a broader `scope` request, not re-authenticate.
 */
export const insufficientScope = (
  wwwAuthenticate: WwwAuthenticateOptions,
  scope: string,
  id: JsonRpcId = null,
): Response =>
  jsonResponse({
    data: rpcError(id, JSONRPC_INSUFFICIENT_SCOPE, `Missing scope: ${scope}`),
    status: 403,
    headers: {
      "WWW-Authenticate": wwwAuthenticateHeader({
        ...wwwAuthenticate,
        error: "insufficient_scope",
        scope,
      }),
    },
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

  await runAuditBounded(() => audit(entry), options.auditTimeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS);
};

/** True when `scope` is unset, granted, or covered by the `"*"` wildcard scope. */
export const hasScope = (principal: Principal, scope: string | undefined): boolean => {
  if (!scope) return true;
  return principal.scopes.includes(scope) || principal.scopes.includes("*");
};
