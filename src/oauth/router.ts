import { jsonResponse, requireHttpMethod } from "../http.js";
import { newClientId } from "./codes.js";
import { GRANT_TYPES, OAUTH_ERRORS } from "./constants.js";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./redirect.js";
import { oauthError, type OAuthRouterOptions } from "./types.js";
import { handleAuthorize } from "./authorize.js";
import { handleToken } from "./token.js";
import { handleWellKnown } from "./wellknown.js";

export type {
  OAuthUser,
  MintedToken,
  OAuthPorts,
  OAuthRouterOptions,
} from "./types.js";

const POST_ONLY = new Set(["POST"]);

const handleRegister = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY);
  if (methodError) return methodError;

  let suppliedRedirectUris = false;
  let redirectUris: string[] = [];
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const raw = body.redirect_uris;
    if (Array.isArray(raw)) {
      suppliedRedirectUris = true;
      redirectUris = raw
        .map((u) => String(u))
        .filter((uri) => isAllowedRedirectUri(uri, options.redirect));
    }
  } catch {
    redirectUris = [];
  }

  if (suppliedRedirectUris && redirectUris.length === 0) {
    return oauthError(
      OAUTH_ERRORS.invalidRedirectUri,
      400,
      "no allowed redirect_uris",
    );
  }

  return jsonResponse({
    client_id: newClientId(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    redirect_uris: redirectUris.length > 0 ? redirectUris : [CLAUDE_CALLBACK],
    grant_types: [GRANT_TYPES.authorizationCode],
    response_types: ["code"],
  });
};

export type OAuthRouter = {
  /** Returns a Response when this request is OAuth-related; otherwise null. */
  tryHandle: (request: Request) => Promise<Response | null>;
};

type RouteHandler = (request: Request) => Promise<Response>;

export const createOAuthRouter = (
  options: OAuthRouterOptions,
): OAuthRouter => {
  const resourcePath = options.resourcePath ?? "/mcp";
  const oauthPath = options.oauthPath ?? "/mcp/oauth";

  const prmPaths = new Set([
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${resourcePath}`,
  ]);
  const asPaths = new Set([
    "/.well-known/oauth-authorization-server",
    `/.well-known/oauth-authorization-server${resourcePath}`,
  ]);

  const routes: Record<string, RouteHandler> = {
    [`${oauthPath}/register`]: (request) => handleRegister(request, options),
    [`${oauthPath}/authorize`]: (request) => handleAuthorize(request, options),
    [`${oauthPath}/token`]: (request) => handleToken(request, options),
  };

  return {
    tryHandle: async (request: Request): Promise<Response | null> => {
      const path = new URL(request.url).pathname;

      const known = await handleWellKnown(request, options, {
        prmPaths,
        asPaths,
        resourcePath,
        oauthPath,
      });
      if (known) return known;

      const route = routes[path];
      return route ? route(request) : null;
    },
  };
};

export {
  authorizationServerMetadata,
  protectedResourceMetadata,
  mcpWwwAuthenticate,
} from "./metadata.js";
export { isAllowedRedirectUri, CLAUDE_CALLBACK } from "./redirect.js";
export {
  issueAuthCode,
  consumeAuthCode,
  newClientId,
  type AuthCodeRecord,
  type CodeStore,
} from "./codes.js";
export { verifyPkceS256, sha256Base64Url, randomBase64Url } from "./pkce.js";
export { GRANT_TYPES, OAUTH_ERRORS, DEFAULT_SCOPE } from "./constants.js";
