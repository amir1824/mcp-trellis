/**
 * One-call MCP server: tools + OAuth AS + routing, wired for real connectors.
 *
 * This layers over `createMcpHandler` and `createOAuthRouter`, which stay
 * exported for anyone who wants to compose the pieces themselves.
 */

import { parseBearer } from "./auth/bearer.js";
import {
  DEFAULT_CLIENTS,
  assertClientsConfigured,
  hasDynamicClient,
  authMethodsFor,
  redirectUrisFor,
  type ClientName,
} from "./clients.js";
import { createMcpHandler } from "./dispatch.js";
import { INTERNAL_ERROR, jsonResponse } from "./http.js";
import type { AuditEntry, Principal, ServerInfo } from "./methods.js";
import { createOAuthRouter } from "./oauth/router.js";
import {
  DEFAULT_RESOURCE_PATH,
  canonicalResource,
  resourcesEqual,
} from "./oauth/resource.js";
import type { CodeStore } from "./oauth/codes.js";
import type {
  ClientStore,
  MintAccessTokenInput,
  MintedToken,
  OAuthUser,
  RefreshAccessTokenInput,
  RevokeTokenInput,
} from "./oauth/types.js";
import { createToolRegistry, type ToolDef } from "./registry.js";

/** What your token verification returns. The library checks the audience. */
export type VerifiedToken = {
  userId: string;
  scopes: string[];
  /** RFC 8707 audience the token was minted for. */
  audience: string;
  /** Optional host claims passed through to `context` via `Principal`. */
  claims?: Record<string, unknown>;
};

export type McpAppAuth = {
  /** HMAC secret for signing auth codes. */
  codeSecret: string | ((req: Request) => string | Promise<string>);
  /** Resolve the logged-in user, or null → redirect to `loginUrl`. */
  resolveUser: (req: Request) => Promise<OAuthUser | null>;
  /** Where to send unauthenticated authorize requests. */
  loginUrl: (req: Request, nextPath: string) => string;
  /** Mint an access token; embed `resource` as the audience. */
  mintAccessToken: (input: MintAccessTokenInput) => Promise<MintedToken>;
  /**
   * Decode and validate a bearer token. Return its `audience` —
   * `createMcpApp` rejects tokens minted for a different resource itself,
   * so this check cannot be forgotten.
   */
  verifyToken: (
    token: string,
    req: Request,
  ) => Promise<VerifiedToken | null>;
  refreshAccessToken?: (
    input: RefreshAccessTokenInput,
  ) => Promise<MintedToken | null>;
  /** RFC 7009 — presence mounts `/revoke` and advertises it. */
  revokeToken?: (input: RevokeTokenInput) => Promise<void>;
  codeStore?: CodeStore;
  /** Required when any configured client is pre-registered (e.g. Gemini). */
  clientStore?: ClientStore;
};

export type McpAppOptions<TCtx> = {
  serverInfo: ServerInfo;
  tools: ToolDef<TCtx>[];
  auth: McpAppAuth;
  /** Connector clients to serve. Default: `["claude"]`. */
  clients?: ClientName[];
  instructions?: string;
  /** MCP endpoint path. Default `"/mcp"`. */
  resourcePath?: string;
  /** OAuth prefix. Default `` `${resourcePath}/oauth` ``. */
  oauthPath?: string;
  /** Scopes this server grants. Default `["mcp"]`. */
  scopes?: string[];
  realm?: string;
  /** Extra exact-match redirect URIs beyond the client profiles. */
  extraRedirectUris?: string[];
  /** Allow loopback redirects (native clients). Default true. */
  allowLoopback?: boolean;
  validateArgs?: boolean;
  onToolError?: (exc: unknown) => string;
  /** Per-request context for tools. Defaults to an empty object. */
  context?: (req: Request, principal: Principal | null) => TCtx | Promise<TCtx>;
  /**
   * Opt-in metrics hook — same as `McpPorts.audit`. Pass a function to get
   * per-request entries (tools + denials); omit for silence. The library
   * never stores or prints these itself. See `consoleAudit` or
   * `examples/audit-store.ts`.
   */
  audit?: (entry: AuditEntry) => void | Promise<void>;
};

export type McpApp = {
  fetch: (request: Request) => Promise<Response>;
};

export const createMcpApp = <TCtx>(
  options: McpAppOptions<TCtx>,
): McpApp => {
  const resourcePath = options.resourcePath ?? DEFAULT_RESOURCE_PATH;
  const oauthPath = options.oauthPath ?? `${resourcePath}/oauth`;
  const clients = options.clients ?? DEFAULT_CLIENTS;
  const realm = options.realm ?? options.serverInfo.name;

  assertClientsConfigured(clients, options.auth.clientStore);

  const registry = createToolRegistry<TCtx>(options.tools, {
    validateArgs: options.validateArgs,
    onToolError: options.onToolError,
  });

  /**
   * The audience check lives here, not in user code — a token minted for
   * another MCP server must never be accepted by this one.
   */
  const authenticate = async (req: Request): Promise<Principal | null> => {
    const token = parseBearer(req.headers.get("authorization"));
    if (!token) return null;

    const verified = await options.auth.verifyToken(token, req);
    if (!verified) return null;

    const expected = canonicalResource(new URL(req.url).origin, resourcePath);
    if (!resourcesEqual(verified.audience, expected)) return null;

    return { id: verified.userId, scopes: verified.scopes, claims: verified.claims };
  };

  const handler = createMcpHandler<TCtx>({
    registry,
    serverInfo: options.serverInfo,
    instructions: options.instructions,
    wwwAuthenticate: (req) => ({
      realm,
      resourceMetadataUrl: `${new URL(req.url).origin}/.well-known/oauth-protected-resource${resourcePath}`,
    }),
    ports: {
      authenticate,
      context: options.context ?? (() => ({}) as TCtx),
      audit: options.audit,
    },
  });

  const oauth = createOAuthRouter({
    resourcePath,
    oauthPath,
    realm,
    scopes: options.scopes,
    tokenEndpointAuthMethods: authMethodsFor(clients),
    allowUnregisteredClients: hasDynamicClient(clients),
    redirect: {
      // Client profiles are the source of truth for callbacks.
      extra: [
        ...redirectUrisFor(clients),
        ...(options.extraRedirectUris ?? []),
      ],
      allowClaude: false,
      allowLoopback: options.allowLoopback ?? true,
    },
    ports: {
      codeSecret: options.auth.codeSecret,
      resolveUser: options.auth.resolveUser,
      loginUrl: options.auth.loginUrl,
      mintAccessToken: options.auth.mintAccessToken,
      refreshAccessToken: options.auth.refreshAccessToken,
      revokeToken: options.auth.revokeToken,
      codeStore: options.auth.codeStore,
      clientStore: options.auth.clientStore,
    },
  });

  return {
    fetch: async (request: Request): Promise<Response> => {
      try {
        const oauthResponse = await oauth.tryHandle(request);
        if (oauthResponse) return oauthResponse;

        if (new URL(request.url).pathname === resourcePath) {
          return await handler.fetch(request);
        }
        return jsonResponse({ error: "Not found" }, 404);
      } catch {
        // Both `oauth` and `handler` already turn port failures into a
        // Response themselves — this is defense in depth, not the primary
        // guard. `fetch` must never reject.
        return jsonResponse({ error: INTERNAL_ERROR }, 500);
      }
    },
  };
};
