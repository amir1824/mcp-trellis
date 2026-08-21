import { BodyTooLargeError } from "../body.js";
import { requireHttpMethod } from "../http.js";
import { firstClientAuthError, readClientAuth } from "./clientauth.js";
import { type AuthCodeRecord, consumeAuthCode } from "./codes.js";
import { GRANT_TYPES, type GrantType, OAUTH_ERRORS } from "./constants.js";
import { verifyPkceS256 } from "./pkce.js";
import { readOAuthBody } from "./reqbody.js";
import { canonicalResource, firstResourceError, resourcesEqual } from "./resource.js";
import { type OAuthRouterOptions, oauthError, resolveSecret, tokenResponse } from "./types.js";

const POST_ONLY = new Set(["POST"]);
const NO_CORS = { cors: false } as const;

type GrantInput = {
  request: Request;
  body: Record<string, string>;
  options: OAuthRouterOptions;
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

  // ponytail: AS cannot verify the refresh token's original audience; the port owns that check.
  const minted = await options.ports.refreshAccessToken({
    refreshToken,
    clientId,
    resource: expectedResource,
  });
  if (!minted) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid refresh_token");
  }
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

  const secret = await resolveSecret(options.ports, request);
  const record = await consumeAuthCode(
    secret,
    body.code ?? "",
    options.ports.codeStore !== undefined ? { codeStore: options.ports.codeStore } : {},
  );
  if (!record) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid or expired code");
  }

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
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  let body: Record<string, string>;
  try {
    body = await readOAuthBody(request);
  } catch (exc) {
    if (exc instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "malformed request body");
  }

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
