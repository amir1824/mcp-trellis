/**
 * Shared JSON/form body reader for `/token` and `/revoke`. `/token` has
 * always accepted both; `/revoke` used to parse form-only, so a client that
 * revoked with `Content-Type: application/json` (matching how it likely
 * called `/token`) got a silent `invalid_request "token required"` — the
 * caller believes the token is dead when the request was never understood.
 */

import { DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../body.js";

const readJsonBody = async (request: Request): Promise<Record<string, string>> => {
  const text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  const body = JSON.parse(text) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("malformed request body");
  }
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  );
};

const readFormBody = async (request: Request): Promise<Record<string, string>> => {
  const text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  const params = new URLSearchParams(text);
  return Object.fromEntries([...params.entries()]);
};

/** JSON when `Content-Type` says so; form-encoded otherwise (the RFC 6749 default). */
export const readOAuthBody = async (request: Request): Promise<Record<string, string>> => {
  const ctype = request.headers.get("Content-Type") ?? "";
  return ctype.includes("application/json") ? readJsonBody(request) : readFormBody(request);
};
