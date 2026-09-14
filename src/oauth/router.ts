import { INTERNAL_ERROR } from "../http.js";
import { safeOAuthAudit } from "./audit.js";
import { handleAuthorize } from "./authorize.js";
import { memoryCodeStore } from "./codes.js";
import {
  assertCodeSecret,
  assertScopeConfig,
  oauthError,
  unregisteredClientsAllowed,
} from "./config.js";
import { handleConsent } from "./consent.js";
import { OAUTH_ERRORS } from "./constants.js";
import { handleRegister } from "./register.js";
import { DEFAULT_RESOURCE_PATH, normalizeConfiguredPath } from "./resource.js";
import { handleRevoke } from "./revoke.js";
import { handleToken } from "./token.js";
import type { OAuthRouterOptions } from "./types.js";
import { handleWellKnown } from "./wellknown.js";

export type {
  MintedToken,
  OAuthAuditEntry,
  OAuthPorts,
  OAuthRouterOptions,
  OAuthUser,
} from "./types.js";

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

  if (!options.ports.codeStore && !options.allowInMemoryCodeStore) {
    throw new Error(
      "ports.codeStore is required (shared jti store for auth-code / consent single-use). " +
        "Pass a CodeStore, or set allowInMemoryCodeStore: true for single-process demos/tests only",
    );
  }

  // Function-form codeSecret is re-validated on every call in resolveSecrets,
  // since its value can vary per request; a string or array form is fixed
  // for the life of this router, so fail fast at construction instead of at
  // the first request.
  if (typeof options.ports.codeSecret === "string") {
    assertCodeSecret(options.ports.codeSecret);
  } else if (Array.isArray(options.ports.codeSecret)) {
    if (options.ports.codeSecret.length === 0) {
      throw new Error("codeSecret array must not be empty — at least one key is required");
    }
    options.ports.codeSecret.forEach(assertCodeSecret);
  }
  assertScopeConfig(options);

  // Resolve the store once so every handler shares the same instance when
  // the in-memory fallback is explicitly allowed.
  const codeStore = options.ports.codeStore ?? memoryCodeStore;
  const ports = { ...options.ports, codeStore };

  // Normalized once here, not per request — "/mcp/" and "/mcp" must never
  // produce divergent canonical resources (canonicalResource doesn't strip
  // a trailing slash itself; normalizeResource, used to compare an
  // incoming request's resource against it, does). oauthPath gets the same
  // treatment — a trailing slash there previously reached the routing
  // table, `handleWellKnown`, and `authorize.ts`'s consent form action
  // completely unnormalized, each potentially disagreeing about the exact
  // path once one of the three had a slash the others didn't expect.
  const resourcePath = normalizeConfiguredPath(options.resourcePath ?? DEFAULT_RESOURCE_PATH);
  const oauthPath = normalizeConfiguredPath(options.oauthPath ?? "/mcp/oauth");

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

  // Every handler below gets the *normalized* resourcePath/oauthPath, not
  // whatever raw values the caller passed (or omitted) — so a handler
  // reading `options.oauthPath` (e.g. `authorize.ts`'s consent form action)
  // always agrees with the routing table built from `oauthPath` above,
  // without re-deriving its own default or normalization.
  const normalizedOptions: OAuthRouterOptions = {
    ...options,
    resourcePath,
    oauthPath,
    ports,
    allowInMemoryCodeStore: options.allowInMemoryCodeStore ?? !options.ports.codeStore,
  };

  const routes: Record<string, RouteHandler> = {
    ...(unregisteredClientsAllowed(options)
      ? {
          [`${oauthPath}/register`]: (request: Request) =>
            handleRegister(request, normalizedOptions),
        }
      : {}),
    [`${oauthPath}/authorize`]: (request) => handleAuthorize(request, normalizedOptions),
    [`${oauthPath}/consent`]: (request) => handleConsent(request, normalizedOptions),
    [`${oauthPath}/token`]: (request) => handleToken(request, normalizedOptions),
    ...(options.ports.revokeToken
      ? {
          [`${oauthPath}/revoke`]: (request: Request) => handleRevoke(request, normalizedOptions),
        }
      : {}),
  };

  return {
    tryHandle: async (request: Request): Promise<Response | null> => {
      try {
        const path = new URL(request.url).pathname;

        const known = await handleWellKnown(request, normalizedOptions, {
          prmPaths,
          asPaths,
          resourcePath,
          oauthPath,
        });
        if (known) return known;

        const route = routes[path];
        return route ? await route(request) : null;
      } catch (caught) {
        // A host port (resolveUser/mintAccessToken/clientStore/...) threw,
        // or codeSecret failed validation (assertCodeSecret, e.g. a
        // per-request function returning something too short). We only
        // ever reach here on a route this router owns, so answer with a
        // real error instead of throwing out of `tryHandle` — the caller
        // gets the generic server_error; ports.audit gets the real reason.
        await safeOAuthAudit(normalizedOptions, {
          event: "server_error",
          reason: caught instanceof Error ? caught.message : String(caught),
        });
        return oauthError(OAUTH_ERRORS.serverError, 500, INTERNAL_ERROR);
      }
    },
  };
};

export {
  type CimdCache,
  type CimdDocument,
  isCimdClientId,
  resolveCimdClient,
} from "./cimd.js";
export { type ClientAuth, firstClientAuthError, readClientAuth } from "./clientauth.js";
export {
  type AuthCodeRecord,
  type CodeStore,
  consumeAuthCode,
  issueAuthCode,
  newClientId,
} from "./codes.js";
export {
  advertisedScopes,
  defaultScopes,
  registeredClientsRequired,
  unregisteredClientsAllowed,
} from "./config.js";
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
