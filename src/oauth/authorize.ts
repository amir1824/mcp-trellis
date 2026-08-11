import { requireHttpMethod } from "../http.js";
import { issueAuthCode } from "./codes.js";
import { OAUTH_ERRORS } from "./constants.js";
import { isAllowedRedirectUri } from "./redirect.js";
import {
  oauthError,
  resolveSecret,
  type OAuthRouterOptions,
} from "./types.js";

const GET_ONLY = new Set(["GET"]);

type AuthzInput = {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  challengeMethod: string;
  redirect: OAuthRouterOptions["redirect"];
};

const firstAuthzError = (input: AuthzInput): Response | null => {
  const rule = [
    {
      ok: input.responseType === "code",
      description: "response_type must be code",
    },
    { ok: Boolean(input.clientId), description: "client_id required" },
    {
      ok:
        Boolean(input.redirectUri) &&
        isAllowedRedirectUri(input.redirectUri, input.redirect),
      description: "invalid redirect_uri",
    },
    {
      ok: Boolean(input.codeChallenge) && input.challengeMethod === "S256",
      description: "PKCE S256 code_challenge required",
    },
  ].find((entry) => !entry.ok);

  return rule
    ? oauthError(OAUTH_ERRORS.invalidRequest, 400, rule.description)
    : null;
};

export const handleAuthorize = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, GET_ONLY);
  if (methodError) return methodError;

  const url = new URL(request.url);
  const responseType = url.searchParams.get("response_type") ?? "";
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge") ?? "";
  const challengeMethod =
    url.searchParams.get("code_challenge_method") ?? "S256";
  const state = url.searchParams.get("state") ?? "";

  const authzError = firstAuthzError({
    responseType,
    clientId,
    redirectUri,
    codeChallenge,
    challengeMethod,
    redirect: options.redirect,
  });
  if (authzError) return authzError;

  const user = await options.ports.resolveUser(request);
  if (!user) {
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(options.ports.loginUrl(request, next), 302);
  }

  const secret = await resolveSecret(options.ports, request);
  const code = await issueAuthCode(secret, {
    clientId,
    redirectUri,
    codeChallenge,
    userId: user.id,
  });

  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target.toString(), 302);
};
