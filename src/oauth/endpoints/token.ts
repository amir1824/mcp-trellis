import { NO_CORS, POST_ONLY, requireHttpMethod } from "../../http/http.js";
import { ownValue } from "../../util/own.js";
import { auditLegacyKeyUsage, safeOAuthAudit } from "../audit.js";
import {
  advertisedScopes,
  grantTypesOf,
  oauthError,
  resolveSecrets,
  tokenResponse,
} from "../config.js";
import { GRANT_TYPES, HTTP_STATUS, OAUTH_ERRORS } from "../constants.js";
import { firstClientAuthError, readClientAuth } from "../crypto/clientauth.js";
import { consumeAuthCodeDetailed } from "../crypto/codes.js";
import { AccessDeniedError } from "../errors.js";
import { firstAuthCodeError } from "../policy/authcode.js";
import { readBodyOrError, readOAuthBody } from "../policy/reqbody.js";
import { canonicalResource, firstResourceError } from "../policy/resource.js";
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

/**
 * Answer a grant with `respond`. An `AccessDeniedError` from a token port is the
 * host refusing the grant on purpose: answer `invalid_grant` and keep the reason
 * in the audit log only. Anything else propagates to the router, which answers
 * `server_error`.
 */
const refusalAsInvalidGrant = async (
  options: ResolvedOAuthRouterOptions,
  clientId: string,
  respond: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await respond();
  } catch (caught) {
    if (!(caught instanceof AccessDeniedError)) throw caught;
    await safeOAuthAudit(options, { event: "access_denied", clientId, reason: caught.message });
    return oauthError(OAUTH_ERRORS.invalidGrant, HTTP_STATUS.badRequest, "access denied");
  }
};

type ReducedScope = { scope: string | undefined } | { error: Response };

// RFC 6749 §6: client MAY request a reduced scope; omit → host keeps original.
const refreshScope = (
  body: Record<string, string>,
  options: ResolvedOAuthRouterOptions,
): ReducedScope => {
  if (body.scope === undefined || body.scope === "") return { scope: undefined };
  const requested = requestedScopes(body.scope, []);
  // `scope=" "` parses to nothing: an omitted scope keeps the original grant,
  // so a whitespace-only one must not reach the port as `""` for it to guess.
  if (requested.length === 0) {
    return {
      error: oauthError(
        OAUTH_ERRORS.invalidScope,
        HTTP_STATUS.badRequest,
        "scope must not be empty",
      ),
    };
  }
  const scopeError = firstScopeError(requested, advertisedScopes(options));
  return scopeError ? { error: scopeError } : { scope: formatScope(requested) };
};

const handleRefresh: GrantHandler = async ({ body, options, expectedResource, clientId }) => {
  if (!options.ports.refreshAccessToken) {
    return oauthError(
      OAUTH_ERRORS.unsupportedGrantType,
      HTTP_STATUS.badRequest,
      "refresh_token not enabled",
    );
  }
  const refreshToken = body.refresh_token ?? "";
  if (!refreshToken) {
    return oauthError(
      OAUTH_ERRORS.invalidRequest,
      HTTP_STATUS.badRequest,
      "refresh_token required",
    );
  }
  const resourceError = firstResourceError(body.resource ?? "", expectedResource);
  if (resourceError) return resourceError;

  const reduced = refreshScope(body, options);
  if ("error" in reduced) return reduced.error;

  // ponytail: AS cannot verify the refresh token's original audience/grant; the port owns those checks.
  return refusalAsInvalidGrant(options, clientId, async () => {
    // Called as a method of `ports` so a port that reads `this` keeps working.
    const minted = await options.ports.refreshAccessToken?.({
      refreshToken,
      clientId,
      resource: expectedResource,
      ...(reduced.scope !== undefined ? { scope: reduced.scope } : {}),
    });
    if (!minted)
      return oauthError(OAUTH_ERRORS.invalidGrant, HTTP_STATUS.badRequest, "invalid refresh_token");
    // Scope in the response must come from the port — not the client's request.
    return tokenResponse(minted);
  });
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
    return oauthError(OAUTH_ERRORS.invalidGrant, HTTP_STATUS.badRequest, "invalid or expired code");
  }
  const { record, keyIndex } = consumed;
  await auditLegacyKeyUsage(options, { clientId, keyIndex, source: "auth code redeemed" });

  const invalid = await firstAuthCodeError({ record, body, clientId, expectedResource });
  if (invalid) return invalid;

  return refusalAsInvalidGrant(options, clientId, async () =>
    tokenResponse(
      await options.ports.mintAccessToken({
        userId: record.userId,
        clientId,
        scope: record.scope,
        resource: record.resource,
      }),
      record.scope,
    ),
  );
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
    return oauthError(OAUTH_ERRORS.invalidRequest, HTTP_STATUS.badRequest, "client_id required");
  }
  const clientAuthError = await firstClientAuthError(auth, options, request);
  if (clientAuthError) return clientAuthError;

  const url = new URL(request.url);
  const expectedResource = canonicalResource(url.origin, options.resourcePath);

  const handler = ownValue(GRANT_HANDLERS, body.grant_type ?? "");
  if (!handler) {
    const supported = grantTypesOf(options.ports);
    return oauthError(
      OAUTH_ERRORS.unsupportedGrantType,
      HTTP_STATUS.badRequest,
      `supported: ${supported.join(", ")}`,
    );
  }
  return handler({
    request,
    body,
    options,
    expectedResource,
    clientId: auth.clientId,
  });
};
