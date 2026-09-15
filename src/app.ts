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
  type ClientName,
  DEFAULT_CLIENTS,
  hasDynamicClient,
  redirectUrisFor,
} from "./clients.js";
import { errorReason, INTERNAL_ERROR, jsonResponse } from "./http/http.js";
import { createMcpHandler, type McpHandler, type McpHandlerOptions } from "./mcp/dispatch.js";
import { type AuditEntry, type Principal, safeAudit } from "./mcp/methods.js";
import { createToolRegistry, type ToolDef } from "./mcp/registry.js";
import { safeOAuthAudit } from "./oauth/audit.js";
import { DEFAULT_SCOPE } from "./oauth/constants.js";
import {
  canonicalResource,
  DEFAULT_RESOURCE_PATH,
  normalizeConfiguredPath,
  resourcesEqual,
} from "./oauth/policy/resource.js";
import { createOAuthRouter, type OAuthRouter } from "./oauth/router.js";
import type { OAuthAuditEntry, OAuthRouterOptions } from "./oauth/types.js";
import { pickDefined } from "./util/defined.js";

export type {
  McpAppAuth,
  McpAppOptions,
  UnifiedAuditEntry,
  VerifiedToken,
} from "./app-options.js";

export type McpApp = {
  fetch: (request: Request) => Promise<Response>;
};

/**
 * On a multi-scope server a tool with no `scope` is callable by a principal
 * holding none of the advertised scopes, silently defeating
 * `defaultScopes: []`. Single-scope servers have no such ambiguity. Pass
 * `scope: null` on a tool to state the omission on purpose.
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

/**
 * The audience check lives here, not in user code — a token minted for
 * another MCP server must never be accepted by this one.
 */
const buildAuthenticate = <TCtx>(
  options: McpAppOptions<TCtx>,
  resourcePath: string,
): ((request: Request) => Promise<Principal | null>) => {
  return async (request: Request): Promise<Principal | null> => {
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
};

/** Top-level `audit` wraps MCP + OAuth; `auth.audit` wins for OAuth if both set. */
const buildAuditAdapters = <TCtx>(
  options: McpAppOptions<TCtx>,
): {
  toMcpAudit: ((entry: AuditEntry) => void | Promise<void>) | undefined;
  oauthAudit: ((entry: OAuthAuditEntry) => void | Promise<void>) | undefined;
} => {
  const unifiedAudit = options.audit;
  const toMcpAudit =
    unifiedAudit !== undefined
      ? (entry: AuditEntry) => unifiedAudit({ source: "mcp", ...entry })
      : undefined;
  const oauthAudit =
    options.auth.audit ??
    (unifiedAudit !== undefined
      ? (entry: OAuthAuditEntry) => unifiedAudit({ source: "oauth", ...entry })
      : undefined);
  return { toMcpAudit, oauthAudit };
};

const buildMcpHandlerOptions = <TCtx>(
  options: McpAppOptions<TCtx>,
  input: {
    resourcePath: string;
    realm: string;
    registry: ReturnType<typeof createToolRegistry<TCtx>>;
    authenticate: (request: Request) => Promise<Principal | null>;
    toMcpAudit: ((entry: AuditEntry) => void | Promise<void>) | undefined;
  },
): McpHandlerOptions<TCtx> => {
  const { resourcePath, realm, registry, authenticate, toMcpAudit } = input;
  return {
    registry,
    serverInfo: options.serverInfo,
    ...pickDefined(options, [
      "instructions",
      "auditTimeoutMs",
      "allowedRequestOrigins",
      "hideToolsOutsideScope",
    ]),
    wwwAuthenticate: (request) => ({
      realm,
      resourceMetadataUrl: `${new URL(request.url).origin}/.well-known/oauth-protected-resource${resourcePath}`,
    }),
    ports: {
      authenticate,
      context: options.context ?? (() => ({}) as TCtx),
      ...(toMcpAudit !== undefined ? { audit: toMcpAudit } : {}),
    },
  };
};

const buildOAuthOptions = <TCtx>(
  options: McpAppOptions<TCtx>,
  input: {
    resourcePath: string;
    oauthPath: string;
    realm: string;
    /** Already resolved to `DEFAULT_CLIENTS` by the caller when unset. */
    clients: ClientName[];
    oauthAudit: ((entry: OAuthAuditEntry) => void | Promise<void>) | undefined;
  },
): OAuthRouterOptions => {
  const { resourcePath, oauthPath, realm, clients, oauthAudit } = input;
  return {
    resourcePath,
    oauthPath,
    realm,
    ...pickDefined(options, [
      "scopes",
      "defaultScopes",
      "auditTimeoutMs",
      "allowInMemoryCodeStore",
      "cimd",
      "cimdCache",
      "cimdLookup",
      "requireRegisteredClients",
      "consent",
    ]),
    tokenEndpointAuthMethods: authMethodsFor(clients),
    allowUnregisteredClients: hasDynamicClient(clients),
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
      ...pickDefined(options.auth, [
        "refreshAccessToken",
        "revokeToken",
        "codeStore",
        "clientStore",
      ]),
      ...(oauthAudit !== undefined ? { audit: oauthAudit } : {}),
    },
  };
};

/** The two halves `createMcpApp` routes between, with the options each was built from. */
type AppParts<TCtx> = {
  resourcePath: string;
  oauth: OAuthRouter;
  oauthOptions: OAuthRouterOptions;
  handler: McpHandler;
  mcpHandlerOptions: McpHandlerOptions<TCtx>;
};

const createAppFetch =
  <TCtx>(parts: AppParts<TCtx>): McpApp["fetch"] =>
  async (request) => {
    try {
      const oauthResponse = await parts.oauth.tryHandle(request);
      if (oauthResponse) return oauthResponse;

      const requestPath = normalizeConfiguredPath(new URL(request.url).pathname);
      if (requestPath === parts.resourcePath) return await parts.handler.fetch(request);
      return jsonResponse({ data: { error: "Not found" }, status: 404 });
    } catch (caught) {
      // Defense in depth: `oauth` and `handler` already turn port failures
      // into responses, but `fetch` must never reject, and this path is
      // audited so it is never silent.
      const reason = errorReason(caught);
      await safeOAuthAudit(parts.oauthOptions, { event: "server_error", reason });
      await safeAudit(parts.mcpHandlerOptions, {
        method: "",
        ok: false,
        error: reason,
        durationMs: 0,
      });
      return jsonResponse({ data: { error: INTERNAL_ERROR }, status: 500 });
    }
  };

export const createMcpApp = <TCtx>(options: McpAppOptions<TCtx>): McpApp => {
  // "/mcp/" and "/mcp" must route identically.
  const resourcePath = normalizeConfiguredPath(options.resourcePath ?? DEFAULT_RESOURCE_PATH);
  // Avoid "//oauth" when the resource is mounted at "/".
  const oauthPath =
    options.oauthPath ?? (resourcePath === "/" ? "/oauth" : `${resourcePath}/oauth`);
  const clients = options.clients ?? DEFAULT_CLIENTS;
  const realm = options.realm ?? options.serverInfo.name;

  assertClientsConfigured(clients, options.auth.clientStore);
  assertToolScopesConfigured(options.tools, options.scopes ?? [DEFAULT_SCOPE]);

  const registry = createToolRegistry<TCtx>(
    options.tools,
    pickDefined(options, ["validateArgs", "onToolError"]),
  );

  const authenticate = buildAuthenticate(options, resourcePath);
  const { toMcpAudit, oauthAudit } = buildAuditAdapters(options);

  // Built once and shared with the `fetch` catch path below, so the fallback
  // audit sees exactly the same ports/timeout as the handler itself.
  const mcpHandlerOptions = buildMcpHandlerOptions(options, {
    resourcePath,
    realm,
    registry,
    authenticate,
    toMcpAudit,
  });
  const oauthOptions = buildOAuthOptions(options, {
    resourcePath,
    oauthPath,
    realm,
    clients,
    oauthAudit,
  });

  return {
    fetch: createAppFetch({
      resourcePath,
      oauth: createOAuthRouter(oauthOptions),
      oauthOptions,
      handler: createMcpHandler<TCtx>(mcpHandlerOptions),
      mcpHandlerOptions,
    }),
  };
};
