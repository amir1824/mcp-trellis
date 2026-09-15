import { NO_CORS, POST_ONLY, requireHttpMethod } from "../../http/http.js";
import { auditLegacyKeyUsage } from "../audit.js";
import { advertisedScopes, oauthError, resolveSecrets, tokenResponse } from "../config.js";
import { GRANT_TYPES, type GrantType, OAUTH_ERRORS } from "../constants.js";
import { firstClientAuthError, readClientAuth } from "../crypto/clientauth.js";
import { type AuthCodeRecord, consumeAuthCodeDetailed } from "../crypto/codes.js";
import { verifyPkceS256 } from "../crypto/pkce.js";
import { readBodyOrError, readOAuthBody } from "../policy/reqbody.js";
import { canonicalResource, firstResourceError, resourcesEqual } from "../policy/resource.js";
import { firstScopeError, formatScope, requestedScopes } from "../policy/scope.js";
import type { ResolvedOAuthRouterOptions } from "../types.js";

type GrantInput = {
  request: Request;
  body: Record<string, string>;
  options: ResolvedOAuthRouterOptions;
  expectedResource: string;
  /** Authenticated client id — may come from the Authorization header. */
  clientId: string;
};

type GrantHandler = (input: GrantInput) => Promise<Response>;

const handleRefresh: GrantHandler = async ({ body, options, expectedResource, clientId }) => {
  if (!options.ports.refreshAccessToken) {
    return oauthError(OAUTH_ERRORS.unsupportedGrantType, 400, "refresh_token not enabled");
  }
  const refreshToken = body.refresh_token ?? "";
  if (!refreshToken) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "refresh_token required");
  }
  const resourceError = firstResourceError(body.resource ?? "", expectedResource);
  if (resourceError) return resourceError;

  // RFC 6749 §6: client MAY request a reduced scope; omit → host keeps original.
  let requestedScope: string | undefined;
  if (body.scope !== undefined && body.scope !== "") {
    const requested = requestedScopes(body.scope, []);
    const scopeError = firstScopeError(requested, advertisedScopes(options));
    if (scopeError) return scopeError;
    requestedScope = formatScope(requested);
  }

  // ponytail: AS cannot verify the refresh token's original audience/grant; the port owns those checks.
  const minted = await options.ports.refreshAccessToken({
    refreshToken,
    clientId,
    resource: expectedResource,
    ...(requestedScope !== undefined ? { scope: requestedScope } : {}),
  });
  if (!minted) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid refresh_token");
  }
  // Scope in the response must come from the port — not the client's request.
  return tokenResponse(minted);
};

const firstAuthCodeMismatch = (
  record: AuthCodeRecord,
  body: Record<string, string>,
  clientId: string,
): Response | null => {
  const rule = [
    {
      ok: record.redirectUri === (body.redirect_uri ?? ""),
      description: "redirect_uri mismatch",
    },
    {
      ok: record.clientId === clientId,
      description: "client_id mismatch",
    },
  ].find((entry) => !entry.ok);

  return rule ? oauthError(OAUTH_ERRORS.invalidGrant, 400, rule.description) : null;
};

const handleAuthCode: GrantHandler = async ({
  request,
  body,
  options,
  expectedResource,
  clientId,
}) => {
  const resourceError = firstResourceError(body.resource ?? "", expectedResource);
  if (resourceError) return resourceError;

  const secrets = await resolveSecrets(options.ports, request);
  const consumed = await consumeAuthCodeDetailed(secrets, body.code ?? "", {
    codeStore: options.ports.codeStore,
  });
  if (!consumed) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid or expired code");
  }
  const { record, keyIndex } = consumed;
  await auditLegacyKeyUsage(options, { clientId, keyIndex, source: "auth code redeemed" });

  const mismatch = firstAuthCodeMismatch(record, body, clientId);
  if (mismatch) return mismatch;

  if (!resourcesEqual(record.resource, expectedResource)) {
    return oauthError(OAUTH_ERRORS.invalidTarget, 400, "auth code bound to a different resource");
  }

  if (!(await verifyPkceS256(body.code_verifier ?? "", record.codeChallenge))) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "pkce verification failed");
  }

  const minted = await options.ports.mintAccessToken({
    userId: record.userId,
    clientId,
    scope: record.scope,
    resource: record.resource,
  });
  return tokenResponse(minted, record.scope);
};

const GRANT_HANDLERS: Record<string, GrantHandler> = {
  [GRANT_TYPES.authorizationCode]: handleAuthCode,
  [GRANT_TYPES.refreshToken]: handleRefresh,
};

export const handleToken = async (
  request: Request,
  options: ResolvedOAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  const body = await readBodyOrError(() => readOAuthBody(request));
  if (body instanceof Response) return body;

  const auth = readClientAuth(request, body);
  if (!auth) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");
  }
  const clientAuthError = await firstClientAuthError(auth, options, request);
  if (clientAuthError) return clientAuthError;

  const url = new URL(request.url);
  const expectedResource = canonicalResource(url.origin, options.resourcePath);

  const handler = GRANT_HANDLERS[body.grant_type ?? ""];
  if (!handler) {
    const supported: GrantType[] = [GRANT_TYPES.authorizationCode];
    if (options.ports.refreshAccessToken) {
      supported.push(GRANT_TYPES.refreshToken);
    }
    return oauthError(OAUTH_ERRORS.unsupportedGrantType, 400, `supported: ${supported.join(", ")}`);
  }
  return handler({
    request,
    body,
    options,
    expectedResource,
    clientId: auth.clientId,
  });
};
