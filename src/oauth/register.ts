/**
 * RFC 7591 Dynamic Client Registration — `POST ${oauthPath}/register`.
 *
 * Zero storage: the issued `client_id` is a sealed assertion of the validated
 * `redirect_uris` (see `sealed.ts`). Unauthenticated callers can still mint
 * their own id; consent + `requireRegisteredClients` address impersonation.
 */

import { BodyTooLargeError, DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../body.js";
import { jsonResponse, requireHttpMethod } from "../http.js";
import { oauthError, resolveSecrets } from "./config.js";
import { GRANT_TYPES, OAUTH_ERRORS } from "./constants.js";
import { CLAUDE_CALLBACK, isAllowedRedirectUri } from "./redirect.js";
import { seal } from "./sealed.js";
import type { ClientAssertion, OAuthRouterOptions } from "./types.js";

const POST_ONLY = new Set(["POST"]);

/**
 * RFC 7591 doesn't cap `redirect_uris`, but this server seals the whole
 * list into the `client_id` it hands back — that `client_id` then travels
 * as an `/authorize` query parameter on every future request, a place with
 * real, if informal, length ceilings (browsers, proxies, access logs). A
 * client legitimately needs a handful of callback URLs at most; this bounds
 * the sealed payload rather than trusting an unauthenticated caller's
 * array length.
 */
const MAX_REGISTER_REDIRECT_URIS = 10;

export const handleRegister = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY);
  if (methodError) return methodError;

  let text: string;
  try {
    text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    return oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "malformed request body");
  }

  // Malformed JSON, or a body that isn't a JSON object, previously fell
  // through to "no redirect_uris supplied" and silently registered the
  // Claude-callback default — a client whose request was never actually
  // understood got back what looked like a successful registration instead
  // of an error explaining why.
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return oauthError(
      OAUTH_ERRORS.invalidClientMetadata,
      400,
      "request body must be a JSON object",
    );
  }

  let suppliedRedirectUris = false;
  let redirectUris: string[] = [];
  const raw = body.redirect_uris;
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      return oauthError(OAUTH_ERRORS.invalidClientMetadata, 400, "redirect_uris must be an array");
    }
    if (raw.length > MAX_REGISTER_REDIRECT_URIS) {
      return oauthError(
        OAUTH_ERRORS.invalidClientMetadata,
        400,
        `redirect_uris must have at most ${MAX_REGISTER_REDIRECT_URIS} entries`,
      );
    }
    suppliedRedirectUris = true;
    redirectUris = raw
      .map((u) => String(u))
      .filter((uri) => isAllowedRedirectUri(uri, options.redirect));
  }

  // No redirect_uris in the body: fall back to the Claude callback only if
  // this server's own allowlist actually accepts it — never advertise a
  // redirect_uri that `/authorize` would go on to reject (e.g. `clients`
  // without `"claude"`, where `createMcpApp` sets `allowClaude: false`).
  if (!suppliedRedirectUris && isAllowedRedirectUri(CLAUDE_CALLBACK, options.redirect)) {
    redirectUris = [CLAUDE_CALLBACK];
  }

  if (redirectUris.length === 0) {
    return oauthError(
      OAUTH_ERRORS.invalidRedirectUri,
      400,
      suppliedRedirectUris
        ? "no allowed redirect_uris"
        : "redirect_uris required — this server has no default redirect_uri",
    );
  }

  // Zero storage: the client_id *is* the registration record — a sealed,
  // self-verifying assertion of the redirect_uris this call just validated.
  // `/authorize` unseals it and binds the client to exactly this list,
  // the same protection a stored registration would give a pre-registered id.
  // Always sealed with the *primary* (first) codeSecret — never an older
  // rotation entry — so every newly issued client_id is verifiable with
  // the fewest possible keys going forward.
  const secrets = await resolveSecrets(options.ports, request);
  const clientId = await seal(secrets[0], "client", {
    redirectUris,
    iat: Math.floor(Date.now() / 1000),
  } satisfies ClientAssertion);

  return jsonResponse({
    data: {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: "none",
      redirect_uris: redirectUris,
      grant_types: [GRANT_TYPES.authorizationCode],
      response_types: ["code"],
    },
  });
};
