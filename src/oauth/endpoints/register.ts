/**
 * RFC 7591 Dynamic Client Registration — `POST ${oauthPath}/register`.
 *
 * Zero storage: the issued `client_id` is a sealed assertion of the validated
 * `redirect_uris` (see `sealed.ts`). Unauthenticated callers can still mint
 * their own id; consent + `requireRegisteredClients` address impersonation.
 */

import { DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../../http/body.js";
import { jsonResponse, POST_ONLY, requireHttpMethod } from "../../http/http.js";
import { isJsonObject } from "../../util/json.js";
import { oauthError, resolveSecrets } from "../config.js";
import { GRANT_TYPES, MAX_CLIENT_REDIRECT_URIS, OAUTH_ERRORS } from "../constants.js";
import { seal } from "../crypto/sealed.js";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "../policy/redirect.js";
import { readBodyOrError } from "../policy/reqbody.js";
import type { ClientAssertion, OAuthRouterOptions } from "../types.js";

/**
 * Malformed JSON or a non-object body is an error, never "no redirect_uris
 * supplied" — that would silently register the Claude-callback default for
 * a request that was never understood.
 */
const parseRegisterBody = (text: string): Record<string, unknown> | Response => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return isJsonObject(parsed)
    ? parsed
    : oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "request body must be a JSON object");
};

/** The allowed, non-empty `redirect_uris` to seal, or the error explaining why there are none. */
const resolveRegisterRedirectUris = (
  body: Record<string, unknown>,
  options: OAuthRouterOptions,
): string[] | Response => {
  const raw = body.redirect_uris;
  if (raw === undefined) {
    // Fall back to the Claude callback only if this server's own allowlist
    // accepts it — never advertise a redirect_uri `/authorize` would reject
    // (e.g. `clients` without `"claude"`, where `allowClaude` is false).
    return isAllowedRedirectUri(CLAUDE_CALLBACK, options.redirect)
      ? [CLAUDE_CALLBACK]
      : oauthError(
          OAUTH_ERRORS.invalidRedirectUri,
          400,
          "redirect_uris required — this server has no default redirect_uri",
        );
  }

  if (!Array.isArray(raw)) {
    return oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "redirect_uris must be an array");
  }
  if (raw.length > MAX_CLIENT_REDIRECT_URIS) {
    return oauthError(
      OAUTH_ERRORS.invalidClientMetadata,
      400,
      `redirect_uris must have at most ${MAX_CLIENT_REDIRECT_URIS} entries`,
    );
  }
  const allowed = raw.map(String).filter((uri) => isAllowedRedirectUri(uri, options.redirect));
  return allowed.length > 0
    ? allowed
    : oauthError(OAUTH_ERRORS.invalidRedirectUri, 400, "no allowed redirect_uris");
};

/**
 * Zero storage: the client_id *is* the registration record — a sealed,
 * self-verifying assertion of the redirect_uris just validated, which
 * `/authorize` binds the client to. Always sealed with the primary
 * `codeSecret`, so new ids verify with the fewest keys going forward.
 */
const issueRegistration = async (
  request: Request,
  options: OAuthRouterOptions,
  redirectUris: string[],
): Promise<Response> => {
  const secrets = await resolveSecrets(options.ports, request);
  const issuedAt = Math.floor(Date.now() / 1000);
  const clientId = await seal(secrets[0], "client", {
    redirectUris,
    iat: issuedAt,
  } satisfies ClientAssertion);

  // RFC 7591 §3.2.1: a successful registration is 201 Created.
  return jsonResponse({
    status: 201,
    data: {
      client_id: clientId,
      client_id_issued_at: issuedAt,
      token_endpoint_auth_method: "none",
      redirect_uris: redirectUris,
      grant_types: [GRANT_TYPES.authorizationCode],
      response_types: ["code"],
    },
  });
};

export const handleRegister = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY);
  if (methodError) return methodError;

  const text = await readBodyOrError(
    () => readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT),
    OAUTH_ERRORS.invalidClientMetadata,
  );
  if (text instanceof Response) return text;

  const body = parseRegisterBody(text);
  if (body instanceof Response) return body;

  const redirectUris = resolveRegisterRedirectUris(body, options);
  if (redirectUris instanceof Response) return redirectUris;
  return issueRegistration(request, options, redirectUris);
};
