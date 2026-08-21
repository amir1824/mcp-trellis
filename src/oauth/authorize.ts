import { requireHttpMethod } from "../http.js";
import { issueAuthCode } from "./codes.js";
import {
  buildCodeRedirectUrl,
  buildErrorRedirectUrl,
  isPreApproved,
  issueConsentTicket,
  renderConsent,
  secureRedirect,
} from "./consent.js";
import { OAUTH_ERRORS } from "./constants.js";
import { isAllowedRedirectUri, type RedirectAllowlistOptions } from "./redirect.js";
import { canonicalResource, resourceErrorInfo } from "./resource.js";
import { formatScope, requestedScopes, scopeErrorInfo } from "./scope.js";
import { unseal } from "./sealed.js";
import {
  advertisedScopes,
  type ClientAssertion,
  defaultScopes,
  type OAuthRouterOptions,
  oauthError,
  registeredClientsRequired,
  resolveSecret,
  unregisteredClientError,
} from "./types.js";

const GET_ONLY = new Set(["GET"]);
/** Reflected into `Location` on denial — an unbounded `state` is a header-size DoS knob. */
const MAX_STATE_LENGTH = 2048;

/**
 * A client bound to a known redirect-URI list — either pre-registered via
 * `clientStore`, or a sealed assertion this server itself issued via
 * `/register` (see `sealed.ts`). Unbound clients fall back to the global
 * allowlist, unless `requireRegisteredClients` forbids that entirely.
 */
const redirectAllowed = (
  redirectUri: string,
  boundRedirectUris: string[] | null,
  allowlist: RedirectAllowlistOptions | undefined,
): boolean => {
  if (!redirectUri) return false;
  if (boundRedirectUris) return boundRedirectUris.includes(redirectUri);
  return isAllowedRedirectUri(redirectUri, allowlist);
};

const redirectToLogin = (request: Request, url: URL, options: OAuthRouterOptions): Response => {
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
  return secureRedirect(loginTarget.toString());
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

  const registered = (await options.ports.clientStore?.get(clientId)) ?? null;
  const secret = await resolveSecret(options.ports, request);
  // Additive: a `client_id` this server itself sealed via `/register` is
  // bound to its own redirect_uris exactly like a pre-registered client,
  // without ever being written to storage. Non-sealed ids unseal to null
  // and keep today's behavior.
  const assertion = registered ? null : await unseal<ClientAssertion>(secret, "client", clientId);

  if (!registered && !assertion) {
    const unregistered = unregisteredClientError(options, {
      code: OAUTH_ERRORS.unauthorizedClient,
      status: 400,
    });
    if (unregistered) return unregistered;
    if (registeredClientsRequired(options)) {
      return oauthError(
        OAUTH_ERRORS.unauthorizedClient,
        400,
        "client_id must come from clientStore or this server's own /register",
      );
    }
  }

  const boundRedirectUris = registered?.redirectUris ?? assertion?.redirectUris ?? null;
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";

  // --- Pre-trust tier: redirect_uri is not yet verified as belonging to a
  // legitimate party, so these two stay direct JSON responses. Redirecting
  // here is exactly the open-redirect risk RFC 6749 §4.1.2.1 exists to
  // avoid — the URI itself is what's in question. An oversized `state` is
  // included in this tier too, for a narrower reason: reflecting it back
  // into the error redirect it would otherwise trigger recreates the
  // header-size DoS the cap exists to prevent, on the one input the cap
  // can't safely echo.
  if (!redirectAllowed(redirectUri, boundRedirectUris, options.redirect)) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "invalid redirect_uri");
  }
  if (state.length > MAX_STATE_LENGTH) {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      400,
      `state must be at most ${MAX_STATE_LENGTH} characters`,
    );
  }

  // --- Post-trust tier: redirect_uri is now trusted, so every remaining
  // error goes back to the client's own callback per RFC 6749 §4.1.2.1
  // instead of a bare JSON body the connector never parses.
  const redirectError = (code: string, description: string): Response =>
    secureRedirect(buildErrorRedirectUrl(redirectUri, code, description, state));

  const responseType = url.searchParams.get("response_type") ?? "";
  if (responseType !== "code") {
    return redirectError(OAUTH_ERRORS.unsupportedResponseType, "response_type must be code");
  }

  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const challengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
  if (!codeChallenge || challengeMethod !== "S256") {
    return redirectError(OAUTH_ERRORS.invalidRequest, "PKCE S256 code_challenge required");
  }

  const resourceIssue = resourceErrorInfo(url.searchParams.get("resource") ?? "", expectedResource);
  if (resourceIssue) return redirectError(resourceIssue.code, resourceIssue.description);

  const advertised = advertisedScopes(options);
  const granted = requestedScopes(url.searchParams.get("scope") ?? "", defaultScopes(options));
  const scopeIssue = scopeErrorInfo(granted, advertised);
  if (scopeIssue) return redirectError(scopeIssue.code, scopeIssue.description);

  const user = await options.ports.resolveUser(request);
  if (!user) return redirectToLogin(request, url, options);

  if (isPreApproved(options, clientId, registered)) {
    const code = await issueAuthCode(secret, {
      clientId,
      redirectUri,
      codeChallenge,
      userId: user.id,
      resource: expectedResource,
      scope: formatScope(granted),
    });
    return secureRedirect(buildCodeRedirectUrl(redirectUri, code, state));
  }

  const ticket = await issueConsentTicket(secret, {
    clientId,
    redirectUri,
    codeChallenge,
    userId: user.id,
    resource: expectedResource,
    scope: formatScope(granted),
    state,
  });
  return renderConsent(options, {
    clientId,
    registeredClient: registered,
    redirectUri,
    scope: granted,
    resource: expectedResource,
    user,
    ticket,
    oauthPath: options.oauthPath ?? "/mcp/oauth",
  });
};
