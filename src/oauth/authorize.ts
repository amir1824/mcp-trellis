import { requireHttpMethod } from "../http.js";
import { issueAuthCode } from "./codes.js";
import { OAUTH_ERRORS } from "./constants.js";
import {
  isAllowedRedirectUri,
  type RedirectAllowlistOptions,
} from "./redirect.js";
import {
  canonicalResource,
  firstResourceError,
} from "./resource.js";
import { firstScopeError, formatScope, requestedScopes } from "./scope.js";
import {
  advertisedScopes,
  oauthError,
  resolveSecret,
  type OAuthRouterOptions,
  type RegisteredClient,
} from "./types.js";

const GET_ONLY = new Set(["GET"]);

/**
 * A pre-registered client is bound to its own redirect URIs.
 * Only unknown (dynamic / public) clients fall back to the global allowlist.
 */
const redirectAllowed = (
  redirectUri: string,
  registered: RegisteredClient | null,
  allowlist: RedirectAllowlistOptions | undefined,
): boolean => {
  if (!redirectUri) return false;
  if (registered) return registered.redirectUris.includes(redirectUri);
  return isAllowedRedirectUri(redirectUri, allowlist);
};

type AuthzInput = {
  responseType: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  resource: string;
  expectedResource: string;
  registered: RegisteredClient | null;
  redirect: RedirectAllowlistOptions | undefined;
};

const firstAuthzError = (input: AuthzInput): Response | null => {
  const rule = [
    {
      ok: input.responseType === "code",
      description: "response_type must be code",
    },
    {
      ok: redirectAllowed(input.redirectUri, input.registered, input.redirect),
      description: "invalid redirect_uri",
    },
    {
      ok: Boolean(input.codeChallenge) && input.challengeMethod === "S256",
      description: "PKCE S256 code_challenge required",
    },
  ].find((entry) => !entry.ok);

  if (rule) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, rule.description);
  }
  return firstResourceError(input.resource, input.expectedResource);
};

export const handleAuthorize = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, GET_ONLY);
  if (methodError) return methodError;

  const url = new URL(request.url);
  const expectedResource = canonicalResource(url.origin, options.resourcePath);

  const clientId = url.searchParams.get("client_id") ?? "";
  if (!clientId) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");
  }

  const registered =
    (await options.ports.clientStore?.get(clientId)) ?? null;

  const authzError = firstAuthzError({
    responseType: url.searchParams.get("response_type") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    challengeMethod:
      url.searchParams.get("code_challenge_method") ?? "S256",
    resource: url.searchParams.get("resource") ?? "",
    expectedResource,
    registered,
    redirect: options.redirect,
  });
  if (authzError) return authzError;

  const advertised = advertisedScopes(options);
  const granted = requestedScopes(
    url.searchParams.get("scope") ?? "",
    advertised,
  );
  const scopeError = firstScopeError(granted, advertised);
  if (scopeError) return scopeError;

  const user = await options.ports.resolveUser(request);
  if (!user) {
    const next = `${url.pathname}${url.search}`;
    const login = options.ports.loginUrl(request, next);
    let loginTarget: URL;
    try {
      loginTarget = new URL(login, url.origin);
    } catch {
      return oauthError(
        OAUTH_ERRORS.invalidRequest,
        500,
        "loginUrl must be absolute or same-origin relative",
      );
    }
    if (loginTarget.protocol !== "http:" && loginTarget.protocol !== "https:") {
      return oauthError(
        OAUTH_ERRORS.invalidRequest,
        500,
        "loginUrl must be absolute or same-origin relative",
      );
    }
    return Response.redirect(loginTarget.toString(), 302);
  }

  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const secret = await resolveSecret(options.ports, request);
  const code = await issueAuthCode(secret, {
    clientId,
    redirectUri,
    codeChallenge: url.searchParams.get("code_challenge") ?? "",
    userId: user.id,
    resource: expectedResource,
    scope: formatScope(granted),
  });

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  const state = url.searchParams.get("state") ?? "";
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
};
