/**
 * Constant-time confidential-client secret hashing.
 *
 * `ClientStore.verifySecret` puts comparison in the host's hands by design
 * — the library must never see or persist plaintext credentials. But that
 * also means a host that writes `stored === presented` gets a timing oracle
 * with no warning, while the library ships a perfectly good
 * `timingSafeEqual` and uses it everywhere else it compares secrets
 * (auth-code HMAC/seal, PKCE). `ClientStore.secretHash` is the alternative:
 * the host still owns storage, but hands the library a stored hash instead
 * of doing the comparison itself, and the library does the compare with
 * the same primitive it already trusts.
 *
 * Keyed by `codeSecret`, HKDF-derived for this specific purpose — not a
 * separate pepper the host has to generate, store, and keep in sync with
 * hashing and verification. This project's whole pitch is "one secret";
 * adding a second one just for client-secret hashing would undercut that
 * for a feature only confidential clients (Gemini Enterprise, in practice)
 * even use.
 *
 * HMAC-SHA256, not a slow password hash (PBKDF2/bcrypt/scrypt/argon2):
 * client secrets are high-entropy, machine-generated values, not
 * human-chosen passwords, so a fast keyed hash is cryptographically
 * adequate here — and a slow hash would burn real CPU budget on every
 * token exchange, on every runtime this library targets, including
 * Cloudflare Workers' request-scoped CPU limits. If your client secrets
 * are human-chosen, don't use this — do a real password hash inside your
 * own `verifySecret` instead.
 */

import { timingSafeEqual } from "../auth/bearer.js";
import { bytesToBase64Url } from "./base64url.js";

const HASH_PREFIX = "hmac-sha256$";
const HKDF_INFO = "mcp-trellis:client-secret-hash";

const deriveHmacKey = async (codeSecretValue: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(codeSecretValue),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
};

/**
 * Hash a client secret for storage in your `ClientStore.secretHash` lookup.
 * Call this once, at registration time, with the same `codeSecret` value
 * your `createOAuthRouter`/`createMcpApp` is configured with — store only
 * the result, never the plaintext secret.
 */
export const hashClientSecret = async (
  secret: string,
  codeSecretValue: string,
): Promise<string> => {
  const key = await deriveHmacKey(codeSecretValue);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(secret));
  return `${HASH_PREFIX}${bytesToBase64Url(sig)}`;
};

/**
 * Verify a presented secret against a stored hash from `hashClientSecret`.
 * Constant-time. Used internally by `firstClientAuthError` when
 * `ClientStore.secretHash` is configured — exported for hosts that want
 * the same check outside the token endpoint (e.g. a client-management API).
 */
export const verifyClientSecret = async (
  presented: string,
  stored: string,
  codeSecretValue: string,
): Promise<boolean> => {
  if (!presented || !stored) return false;
  const recomputed = await hashClientSecret(presented, codeSecretValue);
  return timingSafeEqual(recomputed, stored);
};
