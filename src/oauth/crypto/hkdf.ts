/**
 * Purpose-bound keys derived from `codeSecret` with HKDF-SHA256, cached so
 * rotation (`unsealAny`, `verifyClientSecretAny`) doesn't re-run
 * `importKey` + `deriveKey` for every entry on every request.
 */

import { bytesToBase64Url } from "./base64url.js";
import { createBoundedCache, settleCached } from "./keycache.js";

/** What a derived key is for. `info` is the domain separator: one value per purpose. */
export type HkdfKeyPurpose = {
  info: string;
  algorithm: AesKeyGenParams | HmacKeyGenParams;
  usage: KeyUsage;
};

const deriveKey = async (secret: string, purpose: HkdfKeyPurpose): Promise<CryptoKey> => {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(purpose.info) },
    material,
    purpose.algorithm,
    false,
    [purpose.usage],
  );
};

/**
 * SHA-256 fingerprint of `secret` for the cache key — not a KDF. Keeps the
 * plaintext secret out of Map key space (material still lives inside the
 * derived CryptoKey).
 */
const secretFingerprint = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mcp-trellis:cache-key:${secret}`),
  );
  return bytesToBase64Url(digest);
};

const KEY_CACHE_LIMIT = 64;
const keyCache = createBoundedCache<Promise<CryptoKey>>(KEY_CACHE_LIMIT);

export const hkdfKey = async (secret: string, purpose: HkdfKeyPurpose): Promise<CryptoKey> => {
  const cacheKey = `${purpose.info}:${purpose.usage}:${await secretFingerprint(secret)}`;
  return settleCached(keyCache, cacheKey, () => deriveKey(secret, purpose));
};
