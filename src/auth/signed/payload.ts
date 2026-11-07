/**
 * HMAC-signed JSON payloads for `signedTokenAuth`. Internal: not exported
 * from the package.
 *
 * The HKDF `info` string is the only thing that stops one token type being
 * presented as another (they share the `body.signature` shape), so the kind
 * is a closed set here and never a caller-chosen label.
 */

import { bytesToBase64Url, fromBase64Url } from "../../oauth/crypto/base64url.js";
import { hkdfKey } from "../../oauth/crypto/hkdf.js";
import { isJsonObject } from "../../util/json.js";

const TOKEN_LABELS = {
  access: "mcp-trellis:signed-access-token:v1",
  refresh: "mcp-trellis:signed-refresh-token:v1",
} as const;

type SignedTokenKind = keyof typeof TOKEN_LABELS;

/**
 * Refresh tokens are capped, and `signPayload` enforces it so an oversized one
 * fails when issued, not on every later use. Access tokens are bounded only by
 * the server's header limit, so a long user id still verifies.
 */
const MAX_REFRESH_TOKEN_LENGTH = 4096;

const exceedsCap = (kind: SignedTokenKind, token: string): boolean =>
  kind === "refresh" && token.length > MAX_REFRESH_TOKEN_LENGTH;

const HMAC_SHA256: HmacKeyGenParams = { name: "HMAC", hash: "SHA-256", length: 256 };

const tokenKey = (secret: string, kind: SignedTokenKind, usage: "sign" | "verify") =>
  hkdfKey(secret, { info: TOKEN_LABELS[kind], algorithm: HMAC_SHA256, usage });

export const signPayload = async (
  secret: string,
  kind: SignedTokenKind,
  payload: object,
): Promise<string> => {
  const key = await tokenKey(secret, kind, "sign");
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const token = `${body}.${bytesToBase64Url(signature)}`;
  if (exceedsCap(kind, token)) {
    throw new Error(
      `signedTokenAuth: a refresh token would be ${token.length} characters, over the ` +
        `${MAX_REFRESH_TOKEN_LENGTH} limit — shorten the user id or the scope list`,
    );
  }
  return token;
};

/**
 * True when `signature` verifies `body` under any of `secrets`, tried in order.
 * ponytail: one HMAC per rotation entry for a forged token; `signedTokenAuth`
 * caps the list at 8. Upgrade: carry a key id in the token and look the key up.
 */
const signedByAny = async (
  secrets: readonly string[],
  kind: SignedTokenKind,
  token: { body: string; signature: string },
): Promise<boolean> => {
  const signature = fromBase64Url(token.signature);
  const message = new TextEncoder().encode(token.body);
  for (const secret of secrets) {
    const key = await tokenKey(secret, kind, "verify");
    if (await crypto.subtle.verify("HMAC", key, signature, message)) return true;
  }
  return false;
};

/**
 * The decoded payload of a token of `kind` signed by one of `secrets`, or
 * null for anything else. Callers still shape-check what comes back: a valid
 * signature proves who signed it, not what it contains.
 */
export const verifyPayload = async (
  secrets: readonly string[],
  kind: SignedTokenKind,
  token: string,
): Promise<unknown> => {
  if (exceedsCap(kind, token)) return null;
  const parts = token.split(".");
  const [body, signature] = parts;
  if (parts.length !== 2 || !body || !signature) return null;
  try {
    if (!(await signedByAny(secrets, kind, { body, signature }))) return null;
    return JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
  } catch {
    return null;
  }
};

/** The claims both token kinds carry. */
export type GrantClaims = { userId: string; scopes: string[]; audience: string; exp: number };

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** The shared claims of a verified payload, or null if one is missing, malformed or expired. */
export const parseGrantClaims = (payload: unknown): GrantClaims | null => {
  if (!isJsonObject(payload)) return null;
  const { userId, scopes, audience, exp } = payload;
  if (typeof userId !== "string" || typeof audience !== "string" || !isStringArray(scopes)) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp < Date.now()) return null;
  return { userId, scopes, audience, exp };
};
