/** The built-in consent interstitial, used when the host supplies no `consent.render`. */

import type { ConsentOptions, ConsentRequest } from "../../types.js";

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
 * CSP source for the redirect target. A custom-scheme URI (`myapp://cb`, from
 * `extraRedirectUris`) has the opaque origin `"null"`, which names no source
 * at all — allow its scheme instead, or the browser blocks the redirect.
 */
const formActionSource = (redirectUri: string): string | null => {
  try {
    const { origin, protocol } = new URL(redirectUri);
    const source = origin === "null" ? protocol : origin;
    return isSafeCspSource(source) ? source : null;
  } catch {
    // An unparseable URI (only a `clientStore` can supply one) falls back to `'self'` alone.
    return null;
  }
};

/** `scheme:`, `scheme://host[:port]` or `scheme://[v6][:port]` — nothing that could end a directive. */
const SAFE_CSP_SOURCE =
  /^[a-z][a-z0-9+.-]*:(?:\/\/(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?)?$/;

/**
 * Schemes that must never be granted as a `form-action` source: each runs
 * script, or reads or writes content under the page's own authority.
 */
const FORBIDDEN_CSP_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "blob:",
  "about:",
  "filesystem:",
]);

/**
 * The CSP grammar is not the URL grammar: a host can legally carry `;`, `,`
 * or `'` (`https://a.com;sandbox`), which `new URL` keeps and a header
 * builder would turn into a second directive. Anything that is not a plain
 * scheme or scheme + host source is dropped — `'self'` alone then blocks the
 * redirect back, which fails closed.
 */
const isSafeCspSource = (source: string): boolean =>
  SAFE_CSP_SOURCE.test(source) && !FORBIDDEN_CSP_SCHEMES.has(source);

/**
 * A double-clicked Allow sends two POSTs; the browser keeps the second, whose
 * ticket is already spent, and drops the redirect carrying the code. This
 * lets one submission through. It blocks the repeat instead of disabling the
 * buttons, because a disabled submitter leaves `approved` out of the body.
 */
const SUBMIT_ONCE_SCRIPT =
  'document.getElementById("consent").addEventListener("submit",function(e){if(this.dataset.sent){e.preventDefault();return}this.dataset.sent="1"})';
/** CSP hash of `SUBMIT_ONCE_SCRIPT`; a consent test hashes the rendered script against it. */
const SUBMIT_ONCE_SCRIPT_HASH = "'sha256-Zyrf1VNKMSeFmLaVBxdclhFQvemWfC4XvnQBsjOYkOw='";

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
    `default-src 'none'; style-src 'unsafe-inline'; script-src ${SUBMIT_ONCE_SCRIPT_HASH}; base-uri 'none'; ` +
    `form-action ${["'self'", formActionSource(redirectUri)].filter(Boolean).join(" ")}; ` +
    `frame-ancestors 'none'`,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});

const MAX_CLIENT_ID_DISPLAY = 48;

/**
 * A DCR `client_id` is a sealed blob that grows with its redirect URIs; show its start only.
 * A CIMD `client_id` is a client-chosen URL, so invisible and bidi characters are dropped first.
 */
const shortenClientId = (clientId: string): string => {
  const visible = Array.from(clientId.replace(/\p{C}/gu, ""));
  if (visible.length <= MAX_CLIENT_ID_DISPLAY) return visible.join("");
  return `${visible.slice(0, MAX_CLIENT_ID_DISPLAY).join("")}…`;
};

const scopeItems = (scope: string[], descriptions: ConsentOptions["scopeDescriptions"]): string => {
  if (scope.length === 0) return "(none)";
  const items = scope.map((name) => {
    const description =
      descriptions && Object.hasOwn(descriptions, name) ? descriptions[name] : undefined;
    return `<li>${escapeHtml(name)}${description === undefined ? "" : ` — ${escapeHtml(description)}`}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
};

/** The client's own name is shown below the server-controlled host, always labelled unverified. */
const unverifiedName = (clientName: string | undefined): string =>
  clientName === undefined
    ? ""
    : `<p>It calls itself <bdi>${escapeHtml(clientName)}</bdi> (name not verified).</p>\n`;

/** Built-in hardened interstitial — used whenever the host doesn't supply `consent.render`. */
export const renderBuiltInConsent = (
  input: ConsentRequest,
  options: ConsentOptions = {},
): Response => {
  // A client resolved from `clientStore` is named by the id its operator chose; any other by a host.
  const subject = input.registeredClient
    ? shortenClientId(input.clientId)
    : (input.clientHost ?? "An application");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Authorize access</title>
<style>
  body { font: 16px system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 1rem; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  ul { margin: 0; padding-left: 1.1rem; }
  strong { overflow-wrap: anywhere; }
  bdi { display: inline-block; max-width: 100%; overflow: hidden; overflow-wrap: anywhere; vertical-align: bottom; }
  button { font-size: 1rem; padding: 0.5rem 1.25rem; margin-right: 0.5rem; }
</style>
</head>
<body>
<h1>Authorize access</h1>
<p><strong>${escapeHtml(subject)}</strong> is requesting access to ${escapeHtml(options.appName ?? "your account")}.</p>
${unverifiedName(input.clientName)}<dl>
  <dt>Redirect URI</dt><dd>${escapeHtml(input.redirectUri)}</dd>
  <dt>Client ID</dt><dd>${escapeHtml(shortenClientId(input.clientId))}</dd>
  <dt>Scope</dt><dd>${scopeItems(input.scope, options.scopeDescriptions)}</dd>
  <dt>Resource</dt><dd>${escapeHtml(input.resource)}</dd>
</dl>
<form id="consent" method="POST" action="${escapeHtml(input.oauthPath)}/consent">
  <input type="hidden" name="consent_ticket" value="${escapeHtml(input.ticket)}">
  <button type="submit" name="approved" value="true">Allow</button>
  <button type="submit" name="approved" value="false">Deny</button>
</form>
<script>${SUBMIT_ONCE_SCRIPT}</script>
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
