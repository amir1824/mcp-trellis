/**
 * What a browser shows when the consent POST cannot be honoured: the ticket
 * expired, the app session changed, or the form was submitted twice. JSON
 * is right for an API caller and useless in a tab, so `Accept: text/html`
 * gets a page instead; the status stays 400 either way.
 */

export type ConsentFailureKind = "expired" | "session" | "used";

/**
 * Fixed text only. Nothing from the request, the ticket or the session may
 * reach this page, and "no session" and "a different user" share one kind
 * so the page cannot be used to probe whose ticket it was.
 */
const MESSAGES: Record<ConsentFailureKind, { title: string; detail: string }> = {
  expired: {
    title: "This approval request expired",
    detail:
      "Close this tab, go back to the app you were connecting and start the connection again.",
  },
  session: {
    title: "Your sign-in changed or expired",
    detail:
      "Sign in to the app again, then start the connection again from the app you were connecting.",
  },
  used: {
    title: "This approval was already submitted",
    detail: "If the connection did not complete, start it again from the app you were connecting.",
  },
};

/**
 * `form-action 'none'` and `base-uri 'none'` are not covered by
 * `default-src`; this page has no form and no link, so it grants neither.
 */
const ERROR_PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  Vary: "Accept",
};

/**
 * True only for an explicit `text/html` media range with q > 0. Absent
 * `Accept`, `*\/*` and `text/*` keep the JSON body that API callers parse.
 */
export const acceptsHtml = (accept: string | null): boolean =>
  (accept ?? "").split(",").some((range) => {
    const [type, ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/html") return false;
    const quality = params.find((param) => param.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });

export const renderConsentError = (kind: ConsentFailureKind): Response => {
  const { title, detail } = MESSAGES[kind];
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 16px system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
</style>
</head>
<body>
<h1>${title}</h1>
<p>${detail}</p>
</body>
</html>`;
  return new Response(html, { status: 400, headers: ERROR_PAGE_HEADERS });
};
