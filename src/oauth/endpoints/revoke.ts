/** RFC 7009 token revocation. */

import { NO_CORS, POST_ONLY, requireHttpMethod } from "../../http/http.js";
import { oauthError } from "../config.js";
import { OAUTH_ERRORS } from "../constants.js";
import { firstClientAuthError, readClientAuth } from "../crypto/clientauth.js";
import { readBodyOrError, readOAuthBody } from "../policy/reqbody.js";
import type { OAuthRouterOptions } from "../types.js";

const tokenTypeHintOf = (hint: string | undefined): "access_token" | "refresh_token" | undefined =>
  hint === "access_token" || hint === "refresh_token" ? hint : undefined;

export const handleRevoke = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  const body = await readBodyOrError(() => readOAuthBody(request));
  if (body instanceof Response) return body;
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
