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
  const entries = Object.entries(body as Record<string, unknown>).filter(
    ([, value]) => value != null,
  );
  // `String({})` / `String([])` silently produce "[object Object]" — a
  // truthy, non-empty string every downstream `?? ""` check happily accepts
  // as a real value. Reject a non-scalar field outright instead of
  // stringifying it into something that looks like real (garbage) input.
  const nonScalar = entries.find(([, value]) => typeof value === "object");
  if (nonScalar) {
    throw new Error(`malformed request body: "${nonScalar[0]}" must be a scalar value`);
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value)]));
};

const readFormBody = async (request: Request): Promise<Record<string, string>> => {
  const text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  const params = new URLSearchParams(text);
  // A repeated key (`grant_type=a&grant_type=b`) is ambiguous, not a
  // "last one wins" situation — reject it rather than silently picking
  // whichever value URLSearchParams' entries() happens to iterate last,
  // which invites the request meaning one thing to a layer that reads the
  // first occurrence and another to one that reads the last.
  const body: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(body, key)) {
      throw new Error(`malformed request body: duplicate "${key}" parameter`);
    }
    body[key] = value;
  }
  return body;
};

/** JSON when `Content-Type` says so; form-encoded otherwise (the RFC 6749 default). */
export const readOAuthBody = async (request: Request): Promise<Record<string, string>> => {
  const ctype = request.headers.get("Content-Type") ?? "";
  return ctype.includes("application/json") ? readJsonBody(request) : readFormBody(request);
};
