/**
 * One-call MCP server: tools + OAuth AS + routing, wired for real connectors.
 *
 * This layers over `createMcpHandler` and `createOAuthRouter`, which stay
 * exported for anyone who wants to compose the pieces themselves.
 */

import type { McpAppOptions } from "./app-options.js";
import { parseBearer } from "./auth/bearer.js";
import {
  assertClientsConfigured,
  authMethodsFor,
  DEFAULT_CLIENTS,
  hasDynamicClient,
  redirectUrisFor,
} from "./clients.js";
import { createMcpHandler } from "./dispatch.js";
import { INTERNAL_ERROR, jsonResponse } from "./http.js";
import type { Principal } from "./methods.js";
import { DEFAULT_SCOPE } from "./oauth/constants.js";
import {
  canonicalResource,
  DEFAULT_RESOURCE_PATH,
  normalizeConfiguredPath,
  resourcesEqual,
} from "./oauth/resource.js";
import { createOAuthRouter } from "./oauth/router.js";
import { createToolRegistry, type ToolDef } from "./registry.js";

export type { McpAppAuth, McpAppOptions, VerifiedToken } from "./app-options.js";

export type McpApp = {
  fetch: (request: Request) => Promise<Response>;
};

/**
 * On a server advertising more than one scope, a tool with no `scope` is
 * callable by any authenticated principal — including one holding none of
 * the advertised scopes at all. That's rarely the intent: it's what
 * `defaultScopes: []` in the docs describes as "least privilege" defeated
 * by a single unscoped tool. A single-scope server has no such ambiguity —
 * "any authenticated principal" and "any principal holding the one scope
 * this server grants" already coincide in practice — so this only fires
 * once there's more than one scope to have gotten wrong. Pass `scope: null`
 * on a tool to state the omission on purpose.
 */
const assertToolScopesConfigured = <TCtx>(tools: ToolDef<TCtx>[], scopes: string[]): void => {
  if (scopes.length <= 1) return;
  const unscoped = tools.filter((tool) => tool.scope === undefined).map((tool) => tool.name);
  if (unscoped.length === 0) return;
  throw new Error(
    `scopes has more than one entry (${scopes.join(", ")}), but these tools have no ` +
      `scope and would be callable by any authenticated principal regardless of what ` +
      `scopes it holds: ${unscoped.join(", ")}. Set scope: "<one of the entries above>" ` +
      `on each, or scope: null to state the omission on purpose.`,
  );
};

export const createMcpApp = <TCtx>(options: McpAppOptions<TCtx>): McpApp => {
  // Normalized once here — "/mcp/" and "/mcp" must route identically, not
  // diverge into a 404 for one of them. See `normalizeConfiguredPath`.
  const resourcePath = normalizeConfiguredPath(options.resourcePath ?? DEFAULT_RESOURCE_PATH);
  // `${resourcePath}/oauth` alone produces "//oauth" when resourcePath is
  // the root "/" — normalizeConfiguredPath only strips a trailing slash,
  // not this kind of internal double slash from string concatenation.
  const oauthPath =
    options.oauthPath ?? (resourcePath === "/" ? "/oauth" : `${resourcePath}/oauth`);
  const clients = options.clients ?? DEFAULT_CLIENTS;
  const realm = options.realm ?? options.serverInfo.name;

  assertClientsConfigured(clients, options.auth.clientStore);
  assertToolScopesConfigured(options.tools, options.scopes ?? [DEFAULT_SCOPE]);

  const registry = createToolRegistry<TCtx>(options.tools, {
    ...(options.validateArgs !== undefined ? { validateArgs: options.validateArgs } : {}),
    ...(options.onToolError !== undefined ? { onToolError: options.onToolError } : {}),
  });

  /**
   * The audience check lives here, not in user code — a token minted for
   * another MCP server must never be accepted by this one.
   */
  const authenticate = async (request: Request): Promise<Principal | null> => {
    const token = parseBearer(request.headers.get("authorization"));
    if (!token) return null;

    const verified = await options.auth.verifyToken(token, request);
    if (!verified) return null;

    const expected = canonicalResource(new URL(request.url).origin, resourcePath);
    if (!resourcesEqual(verified.audience, expected)) return null;

    return {
      id: verified.userId,
      scopes: verified.scopes,
      ...(verified.claims !== undefined ? { claims: verified.claims } : {}),
    };
  };

  const handler = createMcpHandler<TCtx>({
    registry,
    serverInfo: options.serverInfo,
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    ...(options.auditTimeoutMs !== undefined ? { auditTimeoutMs: options.auditTimeoutMs } : {}),
    ...(options.allowedRequestOrigins !== undefined
      ? { allowedRequestOrigins: options.allowedRequestOrigins }
      : {}),
    ...(options.hideToolsOutsideScope !== undefined
      ? { hideToolsOutsideScope: options.hideToolsOutsideScope }
      : {}),
    wwwAuthenticate: (request) => ({
      realm,
      resourceMetadataUrl: `${new URL(request.url).origin}/.well-known/oauth-protected-resource${resourcePath}`,
    }),
    ports: {
      authenticate,
      context: options.context ?? (() => ({}) as TCtx),
      ...(options.audit !== undefined ? { audit: options.audit } : {}),
    },
  });

  const oauth = createOAuthRouter({
    resourcePath,
    oauthPath,
    realm,
    ...(options.scopes !== undefined ? { scopes: options.scopes } : {}),
    ...(options.defaultScopes !== undefined ? { defaultScopes: options.defaultScopes } : {}),
    ...(options.auditTimeoutMs !== undefined ? { auditTimeoutMs: options.auditTimeoutMs } : {}),
    tokenEndpointAuthMethods: authMethodsFor(clients),
    allowUnregisteredClients: hasDynamicClient(clients),
    ...(options.requireRegisteredClients !== undefined
      ? { requireRegisteredClients: options.requireRegisteredClients }
      : {}),
    ...(options.consent !== undefined ? { consent: options.consent } : {}),
    redirect: {
      // Client profiles are the source of truth for callbacks.
      extra: [...redirectUrisFor(clients), ...(options.extraRedirectUris ?? [])],
      allowClaude: false,
      allowLoopback: options.allowLoopback ?? true,
    },
    ports: {
      codeSecret: options.auth.codeSecret,
      resolveUser: options.auth.resolveUser,
      loginUrl: options.auth.loginUrl,
      mintAccessToken: options.auth.mintAccessToken,
      ...(options.auth.refreshAccessToken !== undefined
        ? { refreshAccessToken: options.auth.refreshAccessToken }
        : {}),
      ...(options.auth.revokeToken !== undefined ? { revokeToken: options.auth.revokeToken } : {}),
      ...(options.auth.codeStore !== undefined ? { codeStore: options.auth.codeStore } : {}),
      ...(options.auth.clientStore !== undefined ? { clientStore: options.auth.clientStore } : {}),
      ...(options.auth.audit !== undefined ? { audit: options.auth.audit } : {}),
    },
  });

  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        const oauthResponse = await oauth.tryHandle(request);
        if (oauthResponse) return oauthResponse;

        const requestPath = normalizeConfiguredPath(new URL(request.url).pathname);
        if (requestPath === resourcePath) {
          return await handler.fetch(request);
        }
        return jsonResponse({ data: { error: "Not found" }, status: 404 });
      } catch {
        // Both `oauth` and `handler` already turn port failures into a
        // Response themselves — this is defense in depth, not the primary
        // guard. `fetch` must never reject.
        return jsonResponse({ data: { error: INTERNAL_ERROR }, status: 500 });
      }
    },
  };
};
