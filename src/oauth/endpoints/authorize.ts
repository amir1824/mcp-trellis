import { GET_ONLY, requireHttpMethod } from "../../http/http.js";
import { auditLegacyKeyUsage } from "../audit.js";
import { cimdFetchOpts, isCimdClientId, resolveCimdClient } from "../cimd/cimd.js";
import {
  advertisedScopes,
  defaultScopes,
  oauthError,
  registeredClientsRequired,
  resolveSecrets,
  unregisteredClientError,
} from "../config.js";
import { OAUTH_ERRORS } from "../constants.js";
import { issueAuthCode } from "../crypto/codes.js";
import { unsealAny } from "../crypto/sealed.js";
import { isAllowedRedirectUri, type RedirectAllowlistOptions } from "../policy/redirect.js";
import { canonicalResource, resourceErrorInfo } from "../policy/resource.js";
import { formatScope, requestedScopes, scopeErrorInfo } from "../policy/scope.js";
import type {
  ClientAssertion,
  OAuthRouterOptions,
  OAuthUser,
  RegisteredClient,
  ResolvedOAuthRouterOptions,
} from "../types.js";
import { type Callback, codeRedirect, errorRedirect, secureRedirect } from "./callback.js";
import { isPreApproved, issueConsentTicket, renderConsent } from "./consent.js";

/** BASE64URL(SHA-256(verifier)) without padding is always exactly 43 characters. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
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

type AuthorizeClient = {
  registered: RegisteredClient | null;
  boundRedirectUris: string[] | null;
};

/**
 * Resolves `client_id` against `clientStore`, this server's own sealed
 * `/register` assertions, and (when enabled) CIMD — in that order — and
 * rejects when none recognize it and the config requires one to. A sealed
 * assertion binds its own `redirectUris` like a pre-registered client,
 * without ever touching storage.
 */
const resolveAuthorizeClient = async (
  options: OAuthRouterOptions,
  clientId: string,
  secrets: readonly [string, ...string[]],
): Promise<AuthorizeClient | Response> => {
  const registered = (await options.ports.clientStore?.get(clientId)) ?? null;
  const assertion = registered ? null : await unsealClientAssertion(options, clientId, secrets);
  const isCimdId = options.cimd === true && isCimdClientId(clientId);
  const cimdDoc =
    !registered && !assertion && isCimdId
      ? await resolveCimdClient(clientId, cimdFetchOpts(options))
      : null;

  if (!registered && !assertion && !cimdDoc) {
    const unknown = unknownClientError(options, isCimdId);
    if (unknown) return unknown;
  }
  return {
    registered,
    boundRedirectUris:
      registered?.redirectUris ?? assertion?.redirectUris ?? cimdDoc?.redirect_uris ?? null,
  };
};

/** This server's own `/register` assertion for `clientId`, auditing a legacy-key unseal. */
const unsealClientAssertion = async (
  options: OAuthRouterOptions,
  clientId: string,
  secrets: readonly [string, ...string[]],
): Promise<ClientAssertion | null> => {
  const unsealed = await unsealAny<ClientAssertion>(secrets, "client", clientId);
  await auditLegacyKeyUsage(options, {
    clientId,
    keyIndex: unsealed?.keyIndex,
    source: "client assertion unsealed",
  });
  return unsealed?.value ?? null;
};

/** The rejection for a `client_id` nothing resolved, or null when the config admits it. */
const unknownClientError = (options: OAuthRouterOptions, isCimdId: boolean): Response | null => {
  const unregistered = unregisteredClientError(options, {
    code: OAUTH_ERRORS.unauthorizedClient,
    status: 400,
  });
  if (unregistered) return unregistered;
  if (isCimdId) {
    return oauthError(OAUTH_ERRORS.unauthorizedClient, 400, "CIMD client_id could not be resolved");
  }
  if (!registeredClientsRequired(options)) return null;
  return oauthError(
    OAUTH_ERRORS.unauthorizedClient,
    400,
    "client_id must come from clientStore or this server's own /register",
  );
};

/**
 * Pre-trust tier: `redirect_uri` is not yet verified as belonging to a
 * legitimate party, so these two stay direct JSON responses. Redirecting
 * here is exactly the open-redirect risk RFC 6749 §4.1.2.1 exists to
 * avoid — the URI itself is what's in question. An oversized `state` is
 * included in this tier too, for a narrower reason: reflecting it back
 * into the error redirect it would otherwise trigger recreates the
 * header-size DoS the cap exists to prevent, on the one input the cap
 * can't safely echo.
 */
const firstPreTrustError = (
  callback: Callback,
  boundRedirectUris: string[] | null,
  options: OAuthRouterOptions,
): Response | null => {
  if (!redirectAllowed(callback.redirectUri, boundRedirectUris, options.redirect)) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "invalid redirect_uri");
  }
  if (callback.state.length > MAX_STATE_LENGTH) {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      400,
      `state must be at most ${MAX_STATE_LENGTH} characters`,
    );
  }
  return null;
};

/** One `/authorize` request once `client_id` is known. */
type AuthorizeContext = {
  url: URL;
  callback: Callback;
  expectedResource: string;
};

type ValidatedAuthorizeRequest = {
  codeChallenge: string;
  granted: string[];
};

/**
 * Post-trust tier: `redirect_uri` is now trusted, so every remaining error
 * goes back to the client's own callback per RFC 6749 §4.1.2.1 instead of a
 * bare JSON body the connector never parses.
 */
const firstPostTrustError = (
  { url, callback, expectedResource }: AuthorizeContext,
  options: OAuthRouterOptions,
): ValidatedAuthorizeRequest | Response => {
  const redirectError = (code: string, description: string): Response =>
    errorRedirect(callback, code, description);

  const responseType = url.searchParams.get("response_type") ?? "";
  if (responseType !== "code") {
    return redirectError(OAUTH_ERRORS.unsupportedResponseType, "response_type must be code");
  }

  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  // RFC 7636 defaults an absent method to `plain`; this AS only supports
  // S256, so an absent method is read as S256 for client compatibility —
  // a plain-style challenge then fails the shape check below anyway.
  const challengeMethod = url.searchParams.get("code_challenge_method") ?? "S256";
  if (!codeChallenge || challengeMethod !== "S256") {
    return redirectError(OAUTH_ERRORS.invalidRequest, "PKCE S256 code_challenge required");
  }
  if (!S256_CHALLENGE.test(codeChallenge)) {
    return redirectError(
      OAUTH_ERRORS.invalidRequest,
      "code_challenge must be a base64url SHA-256 digest (43 characters)",
    );
  }

  const resourceIssue = resourceErrorInfo(url.searchParams.get("resource") ?? "", expectedResource);
  if (resourceIssue) return redirectError(resourceIssue.code, resourceIssue.description);

  const advertised = advertisedScopes(options);
  const granted = requestedScopes(url.searchParams.get("scope") ?? "", defaultScopes(options));
  const scopeIssue = scopeErrorInfo(granted, advertised);
  if (scopeIssue) return redirectError(scopeIssue.code, scopeIssue.description);

  return { codeChallenge, granted };
};

/** Everything issuing a code or rendering consent needs, once every prior check has passed. */
type AuthorizeOutcomeInput = ValidatedAuthorizeRequest & {
  context: AuthorizeContext;
  clientId: string;
  registered: RegisteredClient | null;
  user: OAuthUser;
};

/** Pre-approved clients skip straight to a code; everyone else gets a consent ticket. */
const issueAuthorizeOutcome = async (
  options: ResolvedOAuthRouterOptions,
  secrets: readonly [string, ...string[]],
  { context, clientId, registered, user, codeChallenge, granted }: AuthorizeOutcomeInput,
): Promise<Response> => {
  const { callback, expectedResource } = context;
  const grant = {
    clientId,
    redirectUri: callback.redirectUri,
    codeChallenge,
    userId: user.id,
    resource: expectedResource,
    scope: formatScope(granted),
  };

  if (isPreApproved(options, clientId, registered)) {
    return codeRedirect(callback, await issueAuthCode(secrets[0], grant));
  }

  const ticket = await issueConsentTicket(secrets[0], { ...grant, state: callback.state });
  return renderConsent(options, {
    clientId,
    registeredClient: registered,
    redirectUri: callback.redirectUri,
    scope: granted,
    resource: expectedResource,
    user,
    ticket,
    oauthPath: options.oauthPath,
  });
};

export const handleAuthorize = async (
  request: Request,
  options: ResolvedOAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, GET_ONLY);
  if (methodError) return methodError;

  const url = new URL(request.url);
  const expectedResource = canonicalResource(url.origin, options.resourcePath);

  const clientId = url.searchParams.get("client_id") ?? "";
  if (!clientId) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");
  }

  const secrets = await resolveSecrets(options.ports, request);
  const clientResolution = await resolveAuthorizeClient(options, clientId, secrets);
  if (clientResolution instanceof Response) return clientResolution;
  const { registered, boundRedirectUris } = clientResolution;

  const callback: Callback = {
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    state: url.searchParams.get("state") ?? "",
    issuer: url.origin,
  };
  const preTrustError = firstPreTrustError(callback, boundRedirectUris, options);
  if (preTrustError) return preTrustError;

  const context: AuthorizeContext = { url, callback, expectedResource };
  const validated = firstPostTrustError(context, options);
  if (validated instanceof Response) return validated;

  const user = await options.ports.resolveUser(request);
  if (!user) return redirectToLogin(request, url, options);

  return issueAuthorizeOutcome(options, secrets, {
    ...validated,
    context,
    clientId,
    registered,
    user,
  });
};
