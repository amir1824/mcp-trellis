/**
 * Shared JSON/form body reader for `/token` and `/revoke`. Both accept both
 * encodings: a client that revokes with the same `Content-Type` it used at
 * `/token` must not get a misleading `token required` and assume the token
 * is dead.
 */

import { BodyTooLargeError, DEFAULT_OAUTH_BODY_LIMIT, readBoundedText } from "../../http/body.js";
import { isJsonObject } from "../../util/json.js";
import { oauthError } from "../config.js";
import { OAUTH_ERRORS } from "../constants.js";

const readJsonBody = async (request: Request): Promise<Record<string, string>> => {
  const text = await readBoundedText(request, DEFAULT_OAUTH_BODY_LIMIT);
  const body = JSON.parse(text) as unknown;
  if (!isJsonObject(body)) throw new Error("malformed request body");
  const entries = Object.entries(body).filter(([, value]) => value != null);
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

/**
 * Runs `read` and turns its two failure modes into the `Response` every
 * caller here (`/token`, `/consent`, `/revoke`, `/register`) already
 * produced by hand: a body over the cap is always 413 `invalid_request`;
 * anything else — bad JSON, an unbalanced form, a non-scalar field — is 400
 * with `invalidBodyErrorCode`, `invalid_request` for everyone except
 * `/register`'s RFC 7591 `invalid_client_metadata`.
 */
export const readBodyOrError = async <T>(
  read: () => Promise<T>,
  invalidBodyErrorCode: string = OAUTH_ERRORS.invalidRequest,
): Promise<T | Response> => {
  try {
    return await read();
  } catch (caught) {
    if (caught instanceof BodyTooLargeError) {
      return oauthError(OAUTH_ERRORS.invalidRequest, 413, "request body too large");
    }
    return oauthError(invalidBodyErrorCode, 400, "malformed request body");
  }
};
