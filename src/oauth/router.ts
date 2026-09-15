import { errorReason, INTERNAL_ERROR } from "../http/http.js";
import { safeOAuthAudit } from "./audit.js";
import {
  assertCodeSecret,
  assertScopeConfig,
  oauthError,
  unregisteredClientsAllowed,
} from "./config.js";
import { DEFAULT_OAUTH_PATH, OAUTH_ERRORS } from "./constants.js";
import { processCodeStore } from "./crypto/codes.js";
import { handleAuthorize } from "./endpoints/authorize.js";
import { handleConsent } from "./endpoints/consent.js";
import { handleRegister } from "./endpoints/register.js";
import { handleRevoke } from "./endpoints/revoke.js";
import { handleToken } from "./endpoints/token.js";
import { handleWellKnown } from "./endpoints/wellknown.js";
import { DEFAULT_RESOURCE_PATH, normalizeConfiguredPath } from "./policy/resource.js";
import type { OAuthRouterOptions, ResolvedOAuthRouterOptions } from "./types.js";

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

/**
 * Function-form `codeSecret` is re-validated on every call in
 * `resolveSecrets`, since its value can vary per request; a string or array
 * form is fixed for the life of this router, so fail fast at construction
 * instead of at the first request.
 */
const assertRouterOptions = (options: OAuthRouterOptions): void => {
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

  if (typeof options.ports.codeSecret === "string") {
    assertCodeSecret(options.ports.codeSecret);
  }
  if (Array.isArray(options.ports.codeSecret)) {
    if (options.ports.codeSecret.length === 0) {
      throw new Error("codeSecret array must not be empty — at least one key is required");
    }
    options.ports.codeSecret.forEach(assertCodeSecret);
  }
  assertScopeConfig(options);
};

type RouterPaths = {
  resourcePath: string;
  oauthPath: string;
  prmPaths: Set<string>;
  asPaths: Set<string>;
};

/**
 * Normalized once, not per request, so "/mcp/" and "/mcp" yield one
 * canonical resource, and the routing table, discovery documents and the
 * consent form action all agree on `oauthPath`.
 */
const normalizeRouterPaths = (options: OAuthRouterOptions): RouterPaths => {
  const resourcePath = normalizeConfiguredPath(options.resourcePath ?? DEFAULT_RESOURCE_PATH);
  const oauthPath = normalizeConfiguredPath(options.oauthPath ?? DEFAULT_OAUTH_PATH);

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

  return {
    resourcePath,
    oauthPath,
    prmPaths: new Set([
      "/.well-known/oauth-protected-resource",
      `/.well-known/oauth-protected-resource${resourcePath}`,
    ]),
    asPaths: new Set([
      "/.well-known/oauth-authorization-server",
      `/.well-known/oauth-authorization-server${resourcePath}`,
    ]),
  };
};

const buildRoutes = (
  options: OAuthRouterOptions,
  normalizedOptions: ResolvedOAuthRouterOptions,
  oauthPath: string,
): Record<string, RouteHandler> => ({
  ...(unregisteredClientsAllowed(options)
    ? {
        [`${oauthPath}/register`]: (request: Request) => handleRegister(request, normalizedOptions),
      }
    : {}),
  [`${oauthPath}/authorize`]: (request: Request) => handleAuthorize(request, normalizedOptions),
  [`${oauthPath}/consent`]: (request: Request) => handleConsent(request, normalizedOptions),
  [`${oauthPath}/token`]: (request: Request) => handleToken(request, normalizedOptions),
  ...(options.ports.revokeToken
    ? {
        [`${oauthPath}/revoke`]: (request: Request) => handleRevoke(request, normalizedOptions),
      }
    : {}),
});

export const createOAuthRouter = (options: OAuthRouterOptions): OAuthRouter => {
  assertRouterOptions(options);

  // Resolved once; `assertRouterOptions` already required
  // `allowInMemoryCodeStore` before the process store can be reached.
  const codeStore = options.ports.codeStore ?? processCodeStore;
  const ports = { ...options.ports, codeStore };

  const { resourcePath, oauthPath, prmPaths, asPaths } = normalizeRouterPaths(options);

  // Handlers read paths from here, never from the caller's raw options.
  const normalizedOptions: ResolvedOAuthRouterOptions = {
    ...options,
    resourcePath,
    oauthPath,
    ports,
  };

  const routes = buildRoutes(options, normalizedOptions, oauthPath);

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
        // A host port threw, or a per-request codeSecret failed validation.
        // Only routes this router owns get here: the caller sees a generic
        // server_error, ports.audit gets the real reason.
        await safeOAuthAudit(normalizedOptions, {
          event: "server_error",
          reason: errorReason(caught),
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
} from "./cimd/cimd.js";
export {
  DEFAULT_SCOPE,
  GRANT_TYPES,
  OAUTH_ERRORS,
  TOKEN_ENDPOINT_AUTH_METHODS,
  type TokenEndpointAuthMethod,
} from "./constants.js";
export type { ClientAuth } from "./crypto/clientauth.js";
export type { AuthCodeRecord, CodeStore } from "./crypto/codes.js";
export { hashClientSecret, verifyClientSecret } from "./crypto/secrethash.js";
// Moved to `mcp-trellis/advanced`; deprecated aliases until 3.0.
export * from "./deprecated.js";
export {
  authorizationServerMetadata,
  mcpWwwAuthenticate,
  protectedResourceMetadata,
} from "./endpoints/metadata.js";
export { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./policy/redirect.js";
export {
  canonicalResource,
  DEFAULT_RESOURCE_PATH,
  resourcesEqual,
} from "./policy/resource.js";
export type {
  ClientAssertion,
  ClientStore,
  ConsentOptions,
  ConsentRequest,
  MintAccessTokenInput,
  OAuthErrorInfo,
  RefreshAccessTokenInput,
  RegisteredClient,
  RevokeTokenInput,
} from "./types.js";
