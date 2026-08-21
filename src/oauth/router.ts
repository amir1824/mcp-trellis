import { BodyTooLargeError, DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../body.js";
import { INTERNAL_ERROR, jsonResponse, requireHttpMethod } from "../http.js";
import { handleAuthorize } from "./authorize.js";
import { handleConsent } from "./consent.js";
import { GRANT_TYPES, OAUTH_ERRORS } from "./constants.js";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./redirect.js";
import { DEFAULT_RESOURCE_PATH, normalizeConfiguredPath } from "./resource.js";
import { handleRevoke } from "./revoke.js";
import { seal } from "./sealed.js";
import { handleToken } from "./token.js";
import {
  assertCodeSecret,
  assertScopeConfig,
  type ClientAssertion,
  type OAuthRouterOptions,
  oauthError,
  resolveSecret,
  safeOAuthAudit,
  unregisteredClientsAllowed,
} from "./types.js";
import { handleWellKnown } from "./wellknown.js";

export type {
  MintedToken,
  OAuthAuditEntry,
  OAuthPorts,
  OAuthRouterOptions,
  OAuthUser,
} from "./types.js";

const POST_ONLY = new Set(["POST"]);

const handleRegister = async (request: Request, options: OAuthRouterOptions): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY);
  if (methodError) return methodError;

  let suppliedRedirectUris = false;
  let redirectUris: string[] = [];
  try {
    const text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
    const body = JSON.parse(text) as Record<string, unknown>;
    const raw = body.redirect_uris;
    if (Array.isArray(raw)) {
      suppliedRedirectUris = true;
      redirectUris = raw
        .map((u) => String(u))
        .filter((uri) => isAllowedRedirectUri(uri, options.redirect));
    }
  } catch (exc) {
    if (exc instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    redirectUris = [];
  }

  // No redirect_uris in the body: fall back to the Claude callback only if
  // this server's own allowlist actually accepts it — never advertise a
  // redirect_uri that `/authorize` would go on to reject (e.g. `clients`
  // without `"claude"`, where `createMcpApp` sets `allowClaude: false`).
  if (!suppliedRedirectUris && isAllowedRedirectUri(CLAUDE_CALLBACK, options.redirect)) {
    redirectUris = [CLAUDE_CALLBACK];
  }

  if (redirectUris.length === 0) {
    return oauthError(
      OAUTH_ERRORS.invalidRedirectUri,
      400,
      suppliedRedirectUris
        ? "no allowed redirect_uris"
        : "redirect_uris required — this server has no default redirect_uri",
    );
  }

  // Zero storage: the client_id *is* the registration record — a sealed,
  // self-verifying assertion of the redirect_uris this call just validated.
  // `/authorize` unseals it and binds the client to exactly this list,
  // the same protection a stored registration would give a pre-registered id.
  const secret = await resolveSecret(options.ports, request);
  const clientId = await seal(secret, "client", { redirectUris } satisfies ClientAssertion);

  return jsonResponse({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    redirect_uris: redirectUris,
    grant_types: [GRANT_TYPES.authorizationCode],
    response_types: ["code"],
  });
};

export type OAuthRouter = {
  /** Returns a Response when this request is OAuth-related; otherwise null. */
  tryHandle: (request: Request) => Promise<Response | null>;
};

type RouteHandler = (request: Request) => Promise<Response>;

export const createOAuthRouter = (options: OAuthRouterOptions): OAuthRouter => {
  if (!unregisteredClientsAllowed(options) && !options.ports.clientStore) {
    throw new Error(
      "allowUnregisteredClients: false requires ports.clientStore " +
        "so pre-registered clients can be resolved",
    );
  }

  // Function-form codeSecret is re-validated on every call in resolveSecret,
  // since its value can vary per request; a string form is fixed for the
  // life of this router, so fail fast at construction instead of at the
  // first request.
  if (typeof options.ports.codeSecret === "string") {
    assertCodeSecret(options.ports.codeSecret);
  }
  assertScopeConfig(options);

  // Normalized once here, not per request — "/mcp/" and "/mcp" must never
  // produce divergent canonical resources (canonicalResource doesn't strip
  // a trailing slash itself; normalizeResource, used to compare an
  // incoming request's resource against it, does).
  const resourcePath = normalizeConfiguredPath(options.resourcePath ?? DEFAULT_RESOURCE_PATH);
  const oauthPath = options.oauthPath ?? "/mcp/oauth";

  if (oauthPath === resourcePath) {
    throw new Error(
      `oauthPath (${oauthPath}) must not equal resourcePath — they would shadow each other`,
    );
  }
  if (resourcePath.startsWith("/.well-known")) {
    throw new Error(
      `resourcePath (${resourcePath}) must not start with /.well-known — reserved for OAuth discovery documents`,
    );
  }

  const prmPaths = new Set([
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${resourcePath}`,
  ]);
  const asPaths = new Set([
    "/.well-known/oauth-authorization-server",
    `/.well-known/oauth-authorization-server${resourcePath}`,
  ]);

  const routes: Record<string, RouteHandler> = {
    ...(unregisteredClientsAllowed(options)
      ? {
          [`${oauthPath}/register`]: (request: Request) => handleRegister(request, options),
        }
      : {}),
    [`${oauthPath}/authorize`]: (request) => handleAuthorize(request, options),
    [`${oauthPath}/consent`]: (request) => handleConsent(request, options),
    [`${oauthPath}/token`]: (request) => handleToken(request, options),
    ...(options.ports.revokeToken
      ? {
          [`${oauthPath}/revoke`]: (request: Request) => handleRevoke(request, options),
        }
      : {}),
  };

  return {
    tryHandle: async (request: Request): Promise<Response | null> => {
      try {
        const path = new URL(request.url).pathname;

        const known = await handleWellKnown(request, options, {
          prmPaths,
          asPaths,
          resourcePath,
          oauthPath,
        });
        if (known) return known;

        const route = routes[path];
        return route ? await route(request) : null;
      } catch (exc) {
        // A host port (resolveUser/mintAccessToken/clientStore/...) threw,
        // or codeSecret failed validation (assertCodeSecret, e.g. a
        // per-request function returning something too short). We only
        // ever reach here on a route this router owns, so answer with a
        // real error instead of throwing out of `tryHandle` — the caller
        // gets the generic server_error; ports.audit gets the real reason.
        await safeOAuthAudit(options, {
          event: "server_error",
          reason: exc instanceof Error ? exc.message : String(exc),
        });
        return oauthError(OAUTH_ERRORS.serverError, 500, INTERNAL_ERROR);
      }
    },
  };
};

export { type ClientAuth, firstClientAuthError, readClientAuth } from "./clientauth.js";
export {
  type AuthCodeRecord,
  type CodeStore,
  consumeAuthCode,
  issueAuthCode,
  newClientId,
} from "./codes.js";
export type { ConsentOptions, ConsentRequest } from "./consent.js";
export { buildErrorRedirectUrl } from "./consent.js";
export {
  DEFAULT_SCOPE,
  GRANT_TYPES,
  OAUTH_ERRORS,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "./constants.js";
export {
  authorizationServerMetadata,
  mcpWwwAuthenticate,
  protectedResourceMetadata,
} from "./metadata.js";
export { randomBase64Url, sha256Base64Url, verifyPkceS256 } from "./pkce.js";
export { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./redirect.js";
export {
  canonicalResource,
  DEFAULT_RESOURCE_PATH,
  firstResourceError,
  normalizeConfiguredPath,
  resourceErrorInfo,
  resourcesEqual,
} from "./resource.js";
export {
  firstScopeError,
  formatScope,
  parseScope,
  requestedScopes,
  scopeErrorInfo,
} from "./scope.js";
export { hashClientSecret, verifyClientSecret } from "./secrethash.js";
export type {
  ClientAssertion,
  ClientStore,
  MintAccessTokenInput,
  OAuthErrorInfo,
  RefreshAccessTokenInput,
  RegisteredClient,
  RevokeTokenInput,
} from "./types.js";
export {
  advertisedScopes,
  defaultScopes,
  registeredClientsRequired,
  unregisteredClientsAllowed,
} from "./types.js";
