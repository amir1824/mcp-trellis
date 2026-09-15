/**
 * Minimal HMAC-signed bearer token for the runnable examples — WebCrypto
 * only, so the exact same code runs unmodified on Node and Cloudflare
 * Workers (see `http-server.ts` and `cloudflare-worker.ts`).
 *
 * This exists because an earlier version of these examples encoded the
 * token as plain `base64(JSON.stringify(payload))` — no signature at all.
 * That is not a simplification safe to copy: anyone can hand-craft a
 * base64 blob with any `userId`/`scope`/`resource` they like and `verifyToken`
 * would accept it as genuine, a full authentication bypass. Signing closes
 * that; it does not turn this into something to actually deploy — a real
 * app should use its existing session/token infrastructure (JWT + JWKS, or
 * an opaque server-side store like `examples/saas-demo/tokens.ts`) rather
 * than hand-rolled bearer tokens either way.
 */

import { bytesToBase64Url, fromBase64Url } from "../src/oauth/crypto/base64url.js";

export type SignedTokenPayload = {
  userId: string;
  scopes: string[];
  audience: string;
  /** Unix ms expiry — `verifyToken` rejects a token past this. */
  exp: number;
  /** Optional host claims (tenant, plan, role, …) — passed through to `context` via `Principal`. */
  claims?: Record<string, unknown>;
};

const hmacKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

/** Sign a token. `secret` should be distinct from `codeSecret` — see the module doc. */
export const signToken = async (secret: string, payload: SignedTokenPayload): Promise<string> => {
  const key = await hmacKey(secret);
  const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bytesToBase64Url(signature)}`;
};

/** Verify and decode a token from `signToken`. `null` on a bad signature, malformed input, or expiry. */
export const verifyToken = async (
  secret: string,
  token: string,
): Promise<SignedTokenPayload | null> => {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(signature),
      new TextEncoder().encode(body),
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as SignedTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};
