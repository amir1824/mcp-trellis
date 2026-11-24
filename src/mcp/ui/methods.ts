/**
 * `resources/list` and `resources/read` for MCP Apps UI resources. Both need an authenticated
 * principal. A resource is visible to a principal who may call at least one tool that references it.
 * Nothing here is per principal: no state, no cache, and never the host's `context` port.
 */

import { jsonResponse } from "../../http/http.js";
import { isJsonObject } from "../../util/json.js";
import { JSONRPC_INVALID_PARAMS, type JsonRpcId, rpcError, rpcResult } from "../jsonrpc.js";
import {
  DENIAL_REASONS,
  insufficientScope,
  mayUse,
  resolveWwwAuthenticate,
  safeAudit,
  unauthorized,
} from "../request-policy.js";
import { shownName } from "../tools/call-args.js";
import type { Principal, ResolvedMcpHandlerOptions, RpcMethodHandler } from "../types.js";
import type { UiEntry, UiRegistry } from "./registry.js";
import { UI_MIME_TYPE } from "./types.js";

const NO_RESOURCES: UiRegistry = new Map();

const isVisibleTo = (principal: Principal, entry: UiEntry): boolean =>
  entry.scopes.some((scope) => mayUse(principal, scope));

type ResourceOutcome = {
  method: "resources/list" | "resources/read";
  principal: Principal | null;
  startedAt: number;
  resource?: string;
  error?: string;
};

const auditResource = <TCtx>(
  options: ResolvedMcpHandlerOptions<TCtx>,
  { method, principal, startedAt, resource, error }: ResourceOutcome,
): Promise<void> =>
  safeAudit(options, {
    method,
    resource,
    principalId: principal?.id,
    ok: error === undefined,
    error,
    durationMs: Date.now() - startedAt,
  });

/** Only reachable when a host lists the method in `publicMethods`: nothing was presented to authenticate with. */
const anonymousResponse = async <TCtx>(
  req: Request,
  options: ResolvedMcpHandlerOptions<TCtx>,
  outcome: ResourceOutcome,
  id: JsonRpcId,
): Promise<Response> => {
  await auditResource(options, { ...outcome, error: DENIAL_REASONS.unauthorized });
  return unauthorized(resolveWwwAuthenticate(options, req), undefined, id);
};

const protocolError = async <TCtx>(
  options: ResolvedMcpHandlerOptions<TCtx>,
  outcome: ResourceOutcome & { error: string },
  id: JsonRpcId,
  message: string,
): Promise<Response> => {
  await auditResource(options, outcome);
  return jsonResponse({ data: rpcError(id, JSONRPC_INVALID_PARAMS, message) });
};

export const UI_METHODS = {
  "resources/list": async ({ req, id, principal, options, startedAt }) => {
    const outcome = { method: "resources/list", principal, startedAt } as const;
    if (!principal) return anonymousResponse(req, options, outcome, id);

    const resources = [...(options.uiRegistry ?? NO_RESOURCES).values()]
      .filter((entry) => isVisibleTo(principal, entry))
      .map(({ resource: { uri, name, description } }) => ({
        uri,
        name: name ?? uri,
        ...(description !== undefined ? { description } : {}),
        mimeType: UI_MIME_TYPE,
      }));
    await auditResource(options, outcome);
    return jsonResponse({ data: rpcResult(id, { resources }) });
  },

  "resources/read": async ({ req, body, id, principal, options, startedAt }) => {
    const outcome = { method: "resources/read", principal, startedAt } as const;
    if (!principal) return anonymousResponse(req, options, outcome, id);

    const uri = isJsonObject(body.params) ? body.params.uri : undefined;
    if (typeof uri !== "string") {
      return protocolError(
        options,
        { ...outcome, error: DENIAL_REASONS.invalidParams },
        id,
        "resources/read params.uri must be a string",
      );
    }

    const shown = shownName(uri);
    const entry = (options.uiRegistry ?? NO_RESOURCES).get(uri);
    const unknown = (error: string) =>
      protocolError(
        options,
        { ...outcome, resource: shown, error },
        id,
        `Unknown resource: ${shown}`,
      );
    if (!entry) return unknown(DENIAL_REASONS.unknownResource);

    if (!isVisibleTo(principal, entry)) {
      // With `hideToolsOutsideScope` a resource the principal may not read does not exist for it.
      if (options.hideToolsOutsideScope) return unknown(DENIAL_REASONS.missingScope);
      await auditResource(options, {
        ...outcome,
        resource: shown,
        error: DENIAL_REASONS.missingScope,
      });
      return insufficientScope(resolveWwwAuthenticate(options, req), entry.scopes[0] ?? "", id);
    }

    const { html, csp } = entry.resource;
    await auditResource(options, { ...outcome, resource: shown });
    return jsonResponse({
      data: rpcResult(id, {
        contents: [
          {
            uri,
            mimeType: UI_MIME_TYPE,
            text: html,
            ...(csp !== undefined ? { _meta: { ui: { csp } } } : {}),
          },
        ],
      }),
    });
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;
