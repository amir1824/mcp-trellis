/** RFC 7009 token revocation. */

import { BodyTooLargeError } from "../body.js";
import { requireHttpMethod } from "../http.js";
import { firstClientAuthError, readClientAuth } from "./clientauth.js";
import { OAUTH_ERRORS } from "./constants.js";
import { readOAuthBody } from "./reqbody.js";
import { type OAuthRouterOptions, oauthError } from "./types.js";

const POST_ONLY = new Set(["POST"]);
const NO_CORS = { cors: false } as const;

const tokenTypeHintOf = (hint: string | undefined): "access_token" | "refresh_token" | undefined =>
  hint === "access_token" || hint === "refresh_token" ? hint : undefined;

export const handleRevoke = async (
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
  const token = body.token ?? "";
  if (!token) return oauthError(OAUTH_ERRORS.invalidRequest, 400, "token required");

  const auth = readClientAuth(request, body);
  if (!auth) return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");

  const clientAuthError = await firstClientAuthError(auth, options, request);
  if (clientAuthError) return clientAuthError;

  const hint = tokenTypeHintOf(body.token_type_hint);
  await options.ports.revokeToken?.({
    token,
    clientId: auth.clientId,
    ...(hint !== undefined ? { tokenTypeHint: hint } : {}),
  });

  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
};
