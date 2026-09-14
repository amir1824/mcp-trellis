import { BodyTooLargeError, DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../body.js";
import { INTERNAL_ERROR, jsonResponse, requireHttpMethod } from "../http.js";
import { safeOAuthAudit } from "./audit.js";
import { handleAuthorize } from "./authorize.js";
import {
  assertCodeSecret,
  assertScopeConfig,
  oauthError,
  resolveSecrets,
  unregisteredClientsAllowed,
} from "./config.js";
import { handleConsent } from "./consent.js";
import { GRANT_TYPES, OAUTH_ERRORS } from "./constants.js";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./redirect.js";
import { DEFAULT_RESOURCE_PATH, normalizeConfiguredPath } from "./resource.js";
import { handleRevoke } from "./revoke.js";
import { seal } from "./sealed.js";
import { handleToken } from "./token.js";
import type { ClientAssertion, OAuthRouterOptions } from "./types.js";
import { handleWellKnown } from "./wellknown.js";

export type {
  MintedToken,
  OAuthAuditEntry,
  OAuthPorts,
  OAuthRouterOptions,
  OAuthUser,
} from "./types.js";

const POST_ONLY = new Set(["POST"]);

/**
 * RFC 7591 doesn't cap `redirect_uris`, but this server seals the whole
 * list into the `client_id` it hands back (see below) — that `client_id`
 * then travels as an `/authorize` query parameter on every future request,
 * a place with real, if informal, length ceilings (browsers, proxies,
 * access logs). A client legitimately needs a handful of callback URLs at
 * most; this bounds the sealed payload rather than trusting an
 * unauthenticated caller's array length.
 */
const MAX_REGISTER_REDIRECT_URIS = 10;

const handleRegister = async (request: Request, options: OAuthRouterOptions): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY);
  if (methodError) return methodError;

  let text: string;
  try {
    text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    return oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "malformed request body");
  }

  // Malformed JSON, or a body that isn't a JSON object, previously fell
  // through to "no redirect_uris supplied" and silently registered the
  // Claude-callback default — a client whose request was never actually
  // understood got back what looked like a successful registration instead
  // of an error explaining why.
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError(
      OAUTH_ERRORS.invalidClientMetadata,
      400,
      "request body must be a JSON object",
    );
  }

  let suppliedRedirectUris = false;
  let redirectUris: string[] = [];
  const raw = body.redirect_uris;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      return oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "redirect_uris must be an array");
    }
    if (raw.length > MAX_REGISTER_REDIRECT_URIS) {
      return oauthError(
        OAUTH_ERRORS.invalidClientMetadata,
        400,
        `redirect_uris must have at most ${MAX_REGISTER_REDIRECT_URIS} entries`,
      );
    }
    suppliedRedirectUris = true;
    redirectUris = raw
      .map((u) => String(u))
      .filter((uri) => isAllowedRedirectUri(uri, options.redirect));
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
  // Always sealed with the *primary* (first) codeSecret — never an older
  // rotation entry — so every newly issued client_id is verifiable with
  // the fewest possible keys going forward.
  const secrets = await resolveSecrets(options.ports, request);
  const clientId = await seal(secrets[0], "client", {
    redirectUris,
    iat: Math.floor(Date.now() / 1000),
  } satisfies ClientAssertion);

  return jsonResponse({
    data: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      redirect_uris: redirectUris,
      grant_types: [GRANT_TYPES.authorizationCode],
      response_types: ["code"],
    },
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
  const normalizedOptions: OAuthRouterOptions = { ...options, resourcePath, oauthPath };

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
