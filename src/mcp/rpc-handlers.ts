/** JSON-RPC method handlers and authenticated dispatch. */

import { jsonResponse } from "../http/http.js";
import { clipText } from "../util/clip.js";
import { ownValue } from "../util/own.js";
import { JSONRPC_INVALID_PARAMS, type JsonRpcRequest, rpcError, rpcResult } from "./jsonrpc.js";
import { DISCOVER_METHODS, serverCapabilities } from "./modern/discover.js";
import type { VersionProfile } from "./modern/profile.js";
import { pickProtocolVersion } from "./protocol.js";
import {
  authFailureChallenge,
  DENIAL_REASONS,
  mayUse,
  safeAudit,
  unauthorized,
} from "./request-policy.js";
import { RESOURCE_METHODS } from "./resources/methods.js";
import { SKILL_METHODS } from "./skills/methods.js";
import {
  auditToolCall,
  invalidArgumentsResponse,
  missingScopeResponse,
  parseToolCallArgs,
  shownName,
  unknownToolResponse,
} from "./tools/call-args.js";
import { firstText } from "./tools/content.js";
import type { Principal, ResolvedMcpHandlerOptions, RpcMethodHandler } from "./types.js";

/** Longest tool-failure text copied into an audit entry — it is tool- or caller-supplied. */
const MAX_AUDIT_ERROR_LENGTH = 1000;

const auditText = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : clipText(text, MAX_AUDIT_ERROR_LENGTH, "…");

const CORE_METHODS = {
  initialize: async ({ id, body, options }) =>
    jsonResponse({
      data: rpcResult(id, {
        protocolVersion: pickProtocolVersion(body.params),
        capabilities: serverCapabilities(options),
        serverInfo: options.serverInfo,
        instructions: options.instructions ?? "",
      }),
    }),

  ping: async ({ id }) => jsonResponse({ data: rpcResult(id, {}) }),

  "tools/list": async ({ id, options, principal, respond }) => {
    const allowScope = options.hideToolsOutsideScope
      ? (scope: string | null | undefined) => mayUse(principal, scope)
      : undefined;
    return respond(id, { tools: options.registry.list(allowScope) });
  },

  "tools/call": async ({ req, body, id, principal, options, startedAt, respond }) => {
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
    return respond(id, result);
  },
} as const satisfies Record<string, RpcMethodHandler<unknown>>;

/** `resources/*` exist only on a server with resources, `skills/*` only on one with skills: otherwise they are as unknown as any other method. */
const ALL_METHODS = { ...CORE_METHODS, ...RESOURCE_METHODS };
const SKILL_TIER_METHODS = { ...ALL_METHODS, ...SKILL_METHODS };

/** What a request that carries the 2026-07-28 header can call: no `initialize`, no `ping`. */
const MODERN_CORE_METHODS = {
  ...DISCOVER_METHODS,
  "tools/list": CORE_METHODS["tools/list"],
  "tools/call": CORE_METHODS["tools/call"],
};
const MODERN_ALL_METHODS = { ...MODERN_CORE_METHODS, ...RESOURCE_METHODS };
const MODERN_SKILL_TIER_METHODS = { ...MODERN_ALL_METHODS, ...SKILL_METHODS };

/** The method table of each version: core, with the resource methods, and with the skill methods too. */
const METHOD_TABLES = {
  legacy: { core: CORE_METHODS, withResources: ALL_METHODS, withSkills: SKILL_TIER_METHODS },
  modern: {
    core: MODERN_CORE_METHODS,
    withResources: MODERN_ALL_METHODS,
    withSkills: MODERN_SKILL_TIER_METHODS,
  },
} as const;

const tierOf = (
  options: Parameters<typeof serverCapabilities>[0],
): "core" | "withResources" | "withSkills" => {
  if (options.skillIndex) return "withSkills";
  return options.resourceCatalog ? "withResources" : "core";
};

export const dispatchRpc = async <TCtx>(input: {
  req: Request;
  body: JsonRpcRequest;
  options: ResolvedMcpHandlerOptions<TCtx>;
  /** Request start (captured in `createMcpHandler.fetch`), for denial-path audit timing. */
  startedAt: number;
  /** What differs by protocol version, chosen from the request's protocol version header. */
  profile: VersionProfile;
}): Promise<Response> => {
  const { req, body, options, startedAt, profile } = input;
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
  const isPublic = profile.publicMethods(options).has(method);
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
  const table = METHOD_TABLES[profile.name];
  const methods = table[tierOf(options)];
  const handler = ownValue(methods as Record<string, RpcMethodHandler<TCtx>>, method);
  if (!handler) return profile.notFound(id, method);

  const respond = profile.writer(method);
  return handler({ req, body, id, principal, options, startedAt, respond });
};
