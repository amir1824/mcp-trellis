/**
 * The consent step between a resolved user and code issuance (RFC 6749
 * §4.1.1 "the resource owner grants or denies the ... request").
 *
 * `/authorize` seals everything the eventual `/consent` POST needs into an
 * opaque, single-use ticket — the ticket carries `clientId`, `redirectUri`,
 * `codeChallenge`, `resource`, and `scope` from the *validated* request, so
 * `handleConsent` trusts nothing from the POST body except which ticket and
 * whether the user approved it. Nothing else in that body is read.
 */

import { BodyTooLargeError } from "../body.js";
import { requireHttpMethod } from "../http.js";
import { safeOAuthAudit } from "./audit.js";
import { issueAuthCode, memoryCodeStore } from "./codes.js";
import { oauthError, resolveSecrets } from "./config.js";
import { OAUTH_ERRORS } from "./constants.js";
import { readOAuthBody } from "./reqbody.js";
import { seal, unsealAny } from "./sealed.js";
import type { OAuthRouterOptions, OAuthUser, RegisteredClient } from "./types.js";

const POST_ONLY = new Set(["POST"]);
const CONSENT_TICKET_TTL_MS = 300_000;

export type ConsentRequest = {
  clientId: string;
  registeredClient: RegisteredClient | null;
  redirectUri: string;
  scope: string[];
  resource: string;
  user: OAuthUser;
  /** Embed this in your form's `consent_ticket` field (hidden input or POST body). */
  ticket: string;
  oauthPath: string;
};

export type ConsentOptions = {
  /**
   * Render the approval page yourself. Return any `Response` — HTML, or a
   * redirect to your own route. Omit for the built-in hardened interstitial.
   *
   * If your page sets its own `Content-Security-Policy` with `form-action`,
   * include `new URL(input.redirectUri).origin` in it — Chromium enforces
   * `form-action` across the redirect your approval POST triggers, not just
   * the immediate submission target, so `'self'` alone blocks the eventual
   * redirect back to the client's own callback.
   */
  render?: (input: ConsentRequest) => Response | Promise<Response>;
  /**
   * Client ids that skip approval. Only honored when `clientStore` actually
   * resolves the id — a DCR or self-invented id is never trusted.
   */
  preApprovedClientIds?: string[];
};

type ConsentTicketPayload = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  resource: string;
  scope: string;
  state: string;
  exp: number;
  jti: string;
};

export const secureRedirect = (location: string): Response =>
  new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });

export const buildCodeRedirectUrl = (redirectUri: string, code: string, state: string): string => {
  const target = new URL(redirectUri);
  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  return target.toString();
};

/**
 * RFC 6749 §4.1.2.1 — once `redirect_uri` is trusted, every authorize-time
 * error goes back to the client's own callback, not a bare JSON body the
 * connector never parses. Shared by consent denial (`buildDeniedRedirectUrl`
 * below) and every post-redirect-trust check in `authorize.ts`
 * (`unsupported_response_type`, PKCE, `invalid_scope`, `invalid_target`, …).
 */
export const buildErrorRedirectUrl = (
  redirectUri: string,
  error: string,
  description: string,
  state: string,
): string => {
  const target = new URL(redirectUri);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return target.toString();
};

/** RFC 6749 §4.1.2.1 — denial goes back to the callback, not a bare JSON error. */
export const buildDeniedRedirectUrl = (redirectUri: string, state: string): string =>
  buildErrorRedirectUrl(redirectUri, OAUTH_ERRORS.accessDenied, "", state);

export const issueConsentTicket = (
  secret: string,
  payload: Omit<ConsentTicketPayload, "exp" | "jti">,
): Promise<string> =>
  seal(secret, "consent", {
    ...payload,
    exp: Date.now() + CONSENT_TICKET_TTL_MS,
    jti: crypto.randomUUID(),
  } satisfies ConsentTicketPayload);

const ESCAPE_HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ESCAPE_HTML[ch] ?? ch);

/**
 * `form-action` governs where a form (and the redirect chain it triggers)
 * may end up — not just the immediate POST target. Chromium enforces it on
 * the 302 this page's own submission produces, so `'self'` alone blocks the
 * approve/deny POST to `${oauthPath}/consent` from ever reaching a
 * `redirectUri` on another origin (the common case — Claude, Gemini,
 * loopback clients). `redirectUri` is already validated by `authorize.ts`
 * before this renders, so its origin is safe to add here.
 */
const consentSecurityHeaders = (redirectUri: string): Record<string, string> => ({
  "Content-Security-Policy":
    `default-src 'none'; style-src 'unsafe-inline'; ` +
    `form-action 'self' ${new URL(redirectUri).origin}; frame-ancestors 'none'`,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});

/** Built-in hardened interstitial — used whenever the host doesn't supply `consent.render`. */
const renderBuiltInConsent = (input: ConsentRequest): Response => {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize access</title>
<style>
  body { font: 16px system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  button { font-size: 1rem; padding: 0.5rem 1.25rem; margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>Authorize access</h1>
<p><strong>${escapeHtml(input.clientId)}</strong> is requesting access to your account.</p>
<dl>
  <dt>Redirect URI</dt><dd>${escapeHtml(input.redirectUri)}</dd>
  <dt>Scope</dt><dd>${escapeHtml(input.scope.join(" ") || "(none)")}</dd>
  <dt>Resource</dt><dd>${escapeHtml(input.resource)}</dd>
</dl>
<form method="POST" action="${escapeHtml(input.oauthPath)}/consent">
  <input type="hidden" name="consent_ticket" value="${escapeHtml(input.ticket)}">
  <button type="submit" name="approved" value="true">Allow</button>
  <button type="submit" name="approved" value="false">Deny</button>
</form>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...consentSecurityHeaders(input.redirectUri),
    },
  });
};

export const renderConsent = async (
  options: OAuthRouterOptions,
  input: ConsentRequest,
): Promise<Response> => (options.consent?.render ?? renderBuiltInConsent)(input);

/** Only honored when `clientStore` actually resolves the id — never a self-invented one. */
export const isPreApproved = (
  options: OAuthRouterOptions,
  clientId: string,
  registered: RegisteredClient | null,
): boolean =>
  Boolean(registered) && (options.consent?.preApprovedClientIds?.includes(clientId) ?? false);

export const handleConsent = async (
  request: Request,
  options: OAuthRouterOptions,
): Promise<Response> => {
  const methodError = requireHttpMethod(request, POST_ONLY, { cors: false });
  if (methodError) return methodError;

  let body: Record<string, string>;
  try {
    body = await readOAuthBody(request);
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "malformed request body");
  }

  const ticket = body.consent_ticket ?? "";
  if (!ticket) {
    return oauthError(OAUTH_ERRORS.invalidRequest, 400, "consent_ticket required");
  }

  const secrets = await resolveSecrets(options.ports, request);
  const unsealed = await unsealAny<ConsentTicketPayload>(secrets, "consent", ticket);
  const payload = unsealed?.value ?? null;
  if (
    !payload ||
    typeof payload.exp !== "number" ||
    payload.exp < Date.now() ||
    typeof payload.jti !== "string" ||
    !payload.jti
  ) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "invalid or expired consent_ticket");
  }
  if (unsealed && unsealed.keyIndex > 0) {
    await safeOAuthAudit(options, {
      event: "legacy_code_secret_used",
      clientId: payload.clientId,
      reason: `consent ticket unsealed with codeSecret[${unsealed.keyIndex}]`,
    });
  }

  // Shares the same store `codes.ts` uses for auth codes when no
  // `ports.codeStore` is configured — the `ct:` prefix disambiguates a
  // ticket's jti from a code's, so one Map and one prune throttle serve
  // both instead of two independent, unthrottled ones.
  const store = options.ports.codeStore ?? memoryCodeStore;
  const fresh = await store.consume(`ct:${payload.jti}`, payload.exp);
  if (!fresh) {
    return oauthError(OAUTH_ERRORS.invalidGrant, 400, "consent_ticket already used");
  }

  const user = await options.ports.resolveUser(request);
  if (!user || user.id !== payload.userId) {
    return oauthError(
      OAUTH_ERRORS.invalidGrant,
      400,
      "consent_ticket does not match the current user",
    );
  }

  if (body.approved !== "true") {
    return secureRedirect(buildDeniedRedirectUrl(payload.redirectUri, payload.state));
  }

  const code = await issueAuthCode(secrets[0], {
    clientId: payload.clientId,
    redirectUri: payload.redirectUri,
    codeChallenge: payload.codeChallenge,
    userId: user.id,
    resource: payload.resource,
    scope: payload.scope,
  });
  return secureRedirect(buildCodeRedirectUrl(payload.redirectUri, code, payload.state));
};
