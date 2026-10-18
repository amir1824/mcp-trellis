/** The built-in consent interstitial, used when the host supplies no `consent.render`. */

import type { ConsentRequest } from "../types.js";

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
  const { origin, protocol } = new URL(redirectUri);
  const source = origin === "null" ? protocol : origin;
  return isSafeCspSource(source) ? source : null;
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
    `form-action ${["'self'", formActionSource(redirectUri)].filter(Boolean).join(" ")}; ` +
    `frame-ancestors 'none'`,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
});

/** Built-in hardened interstitial — used whenever the host doesn't supply `consent.render`. */
export const renderBuiltInConsent = (input: ConsentRequest): Response => {
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
