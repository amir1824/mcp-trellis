/** What a `resources/*` request ends in when it is not a success: the response, and the audit entry it leaves. */

import { jsonResponse } from "../../http/http.js";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  type JsonRpcId,
  rpcError,
} from "../jsonrpc.js";
import {
  DENIAL_REASONS,
  insufficientScope,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "../request-policy.js";
import { shownName } from "../tools/call-args.js";
import type { Principal, ResolvedMcpHandlerOptions } from "../types.js";
import type { Access } from "./access.js";

/** The noun an unknown-target answer uses, by method. */
const NOUNS = {
  "resources/list": "resource",
  "resources/read": "resource",
  "skills/list": "skill",
  "skills/get": "skill",
} as const;

/** What every outcome of one request needs; the handlers build it once. */
export type ResourceCall<TCtx> = {
  method: keyof typeof NOUNS;
  req: Request;
  id: JsonRpcId;
  principal: Principal | null;
  options: ResolvedMcpHandlerOptions<TCtx>;
  startedAt: number;
};

/** Fixed text: whatever a provider threw is never part of it. */
const READ_FAILED_MESSAGE = "Resource read failed";

export const auditResource = <TCtx>(
  call: ResourceCall<TCtx>,
  detail: { resource?: string; error?: string } = {},
): Promise<void> =>
  safeAudit(call.options, {
    method: call.method,
    resource: detail.resource,
    principalId: call.principal?.id,
    ok: detail.error === undefined,
    error: detail.error,
    durationMs: Date.now() - call.startedAt,
  });

/** Only reachable when a host lists the method in `publicMethods`: nothing was presented to authenticate with. */
export const anonymousResponse = async <TCtx>(call: ResourceCall<TCtx>): Promise<Response> => {
  await auditResource(call, { error: DENIAL_REASONS.unauthorized });
  return unauthorized(resolveWwwAuthenticate(call.options, call.req), undefined, call.id);
};

export const invalidParamsResponse = async <TCtx>(call: ResourceCall<TCtx>): Promise<Response> => {
  await auditResource(call, { error: DENIAL_REASONS.invalidParams });
  return jsonResponse({
    data: rpcError(call.id, JSONRPC_INVALID_PARAMS, `${call.method} params.uri must be a string`),
  });
};

/** The one answer for a URI that is unknown and for one the caller may not know exists. */
export const unknownResponse = async <TCtx>(
  call: ResourceCall<TCtx>,
  detail: { uri: string; reason: string },
): Promise<Response> => {
  const resource = shownName(detail.uri);
  await auditResource(call, { resource, error: detail.reason });
  return jsonResponse({
    data: rpcError(call.id, JSONRPC_INVALID_PARAMS, `Unknown ${NOUNS[call.method]}: ${resource}`),
  });
};

/**
 * With `hideToolsOutsideScope` (true or "strict") a resource the principal may not read does not exist for
 * it. Otherwise a missing scope is a 403 that names it; a failed `allow` rule has no scope to name.
 */
export const deniedResponse = async <TCtx>(
  call: ResourceCall<TCtx>,
  detail: { uri: string; access: Exclude<Access, { allowed: true }> },
): Promise<Response> => {
  const { uri, access } = detail;
  if (access.reason === "rule") {
    const reason = access.failed ? DENIAL_REASONS.ruleFailed : DENIAL_REASONS.ruleDenied;
    return unknownResponse(call, { uri, reason });
  }
  if (call.options.hideToolsOutsideScope) {
    return unknownResponse(call, { uri, reason: DENIAL_REASONS.missingScope });
  }
  await auditResource(call, { resource: shownName(uri), error: DENIAL_REASONS.missingScope });
  return insufficientScope(resolveWwwAuthenticate(call.options, call.req), access.scope, call.id);
};

export const readFailedResponse = async <TCtx>(
  call: ResourceCall<TCtx>,
  uri: string,
): Promise<Response> => {
  await auditResource(call, { resource: shownName(uri), error: DENIAL_REASONS.resourceFailed });
  return jsonResponse({ data: rpcError(call.id, JSONRPC_INTERNAL_ERROR, READ_FAILED_MESSAGE) });
};
