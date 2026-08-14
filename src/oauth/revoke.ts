/** RFC 7009 token revocation. */

import { requireHttpMethod } from "../http.js";
import { firstClientAuthError, readClientAuth } from "./clientauth.js";
import { OAUTH_ERRORS } from "./constants.js";
import { oauthError, type OAuthRouterOptions } from "./types.js";

const POST_ONLY = new Set(["POST"]);
const NO_CORS = { cors: false } as const;

const tokenTypeHintOf = (
  hint: string | undefined,
): "access_token" | "refresh_token" | undefined =>
  hint === "access_token" || hint === "refresh_token" ? hint : undefined;

export const handleRevoke = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, NO_CORS);
  if (methodError) return methodError;

  const body = Object.fromEntries(
    new URLSearchParams(await request.text()).entries(),
  );
  const token = body.token ?? "";
  if (!token) return oauthError(OAUTH_ERRORS.invalidRequest, 400, "token required");

  const auth = readClientAuth(request, body);
  if (!auth) return oauthError(OAUTH_ERRORS.invalidRequest, 400, "client_id required");

  const clientAuthError = await firstClientAuthError(auth, options);
  if (clientAuthError) return clientAuthError;

  await options.ports.revokeToken?.({
    token,
    clientId: auth.clientId,
    tokenTypeHint: tokenTypeHintOf(body.token_type_hint),
  });

  return new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });
};
