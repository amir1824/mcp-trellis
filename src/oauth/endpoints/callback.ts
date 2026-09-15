/**
 * Responses that send the user agent back to the client's own, already
 * validated `redirect_uri` — the code on success, the error otherwise
 * (RFC 6749 §4.1.2 / §4.1.2.1), with `iss` per RFC 9207.
 */

/** The validated client callback one authorize/consent round trip returns to. */
export type Callback = {
  redirectUri: string;
  state: string;
  issuer: string;
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

/** Empty values are omitted, and `state` / `iss` always come last. */
const callbackUrl = (
  callback: { redirectUri: string; state: string; issuer?: string | undefined },
  params: Record<string, string>,
): string => {
  const target = new URL(callback.redirectUri);
  const entries = [...Object.entries(params), ["state", callback.state], ["iss", callback.issuer]];
  for (const [key, value] of entries) {
    if (key && value) target.searchParams.set(key, value);
  }
  return target.toString();
};

export const codeRedirect = (callback: Callback, code: string): Response =>
  secureRedirect(callbackUrl(callback, { code }));

export const errorRedirect = (callback: Callback, error: string, description = ""): Response =>
  secureRedirect(callbackUrl(callback, { error, error_description: description }));

/**
 * URL form of `errorRedirect`, for hosts composing their own authorize flow
 * (`mcp-trellis/advanced`). `issuer`, when set, adds `iss` (RFC 9207).
 */
export const buildErrorRedirectUrl = (
  redirectUri: string,
  error: string,
  description: string,
  state: string,
  issuer?: string,
): string => callbackUrl({ redirectUri, state, issuer }, { error, error_description: description });
