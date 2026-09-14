/** Shared cache-key fingerprint so secrets never sit as Map keys. */

import { bytesToBase64Url } from "./base64url.js";

/**
 * SHA-256 fingerprint of `secret` for bounded key caches — not a KDF.
 * Keeps the plaintext secret out of Map key space (material still lives
 * inside the derived CryptoKey).
 */
export const secretCacheFingerprint = async (secret: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`mcp-trellis:cache-key:${secret}`),
  );
  return bytesToBase64Url(digest);
};
