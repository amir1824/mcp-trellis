import assert from "node:assert/strict";
import { asFetch, originOf, type Target } from "./target.js";

/** POST a JSON-RPC body to `/mcp`. */
export const jsonRpc = (target: Target, body: unknown, token?: string): Promise<Response> =>
  asFetch(target)(
    new Request(`${originOf(target)}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

/** Assert the status, then parse and return the JSON body. */
export const expectJson = async <T>(res: Response, status: number): Promise<T> => {
  assert.equal(res.status, status, await res.clone().text());
  return (await res.json()) as T;
};

/** Assert an OAuth error response's status and `error` code. */
export const expectOAuthError = async (
  res: Response,
  status: number,
  error: string,
): Promise<void> => {
  const body = await expectJson<{ error: string }>(res, status);
  assert.equal(body.error, error);
};

/**
 * Assert a post-redirect-trust `/authorize` error (RFC 6749 §4.1.2.1): a
 * 302 back to `redirectUri` carrying `error` (and `state`, when given) in
 * the query string — not a direct JSON body. Returns the parsed `Location`
 * for callers that want to check `error_description` too.
 */
export const expectOAuthRedirectError = (res: Response, error: string, state?: string): URL => {
  assert.equal(res.status, 302);
  const location = res.headers.get("location");
  assert.ok(location, "expected a Location header");
  const url = new URL(location);
  assert.equal(url.searchParams.get("error"), error);
  if (state !== undefined) assert.equal(url.searchParams.get("state"), state);
  return url;
};
