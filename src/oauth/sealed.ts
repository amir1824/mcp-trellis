/**
 * AES-GCM sealing for short-lived, self-describing tokens derived from the
 * same `codeSecret` as auth codes (HMAC today, AES-GCM from Phase 2 —
 * see `codes.ts`).
 *
 * Domain separation is mandatory, not a nice-to-have: a consent ticket must
 * never unseal as a client-id assertion, and neither must ever unseal as an
 * auth code. HKDF derives an independent AES-256 key per `SealedType` from
 * the same secret, and the type is also bound in as AEAD associated data —
 * two independent reasons decryption fails across types, not one.
 */

import { bytesToBase64Url, fromBase64Url } from "./base64url.js";
import { createBoundedCache } from "./keycache.js";
import { secretCacheFingerprint } from "./secretfingerprint.js";

export type SealedType = "consent" | "client" | "code";

const HKDF_INFO_PREFIX = "mcp-trellis:sealed:";
const IV_BYTES = 12;

const deriveKey = async (
  secret: string,
  type: SealedType,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(`${HKDF_INFO_PREFIX}${type}`),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
};

const KEY_CACHE_LIMIT = 32;
const keyCache = createBoundedCache<Promise<CryptoKey>>(KEY_CACHE_LIMIT);

/** Same key material for "encrypt" and "decrypt" — WebCrypto just restricts the derived key's own `usages`. */
const cachedDeriveKey = (
  secret: string,
  type: SealedType,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> => {
  const pending = (async () => {
    const cacheKey = `${type}:${usage}:${await secretCacheFingerprint(secret)}`;
    const cached = keyCache.get(cacheKey);
    if (cached) return cached;
    const derived = deriveKey(secret, type, usage);
    keyCache.set(cacheKey, derived);
    return derived;
  })();
  return pending;
};

/** Seals `payload` as an opaque, type-bound string. */
export const seal = async <T>(secret: string, type: SealedType, payload: T): Promise<string> => {
  const key = await cachedDeriveKey(secret, type, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const additionalData = new TextEncoder().encode(type);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
};

/** Unseals a string sealed with the same `secret` and `type`; `null` on any mismatch or tamper. */
export const unseal = async <T>(
  secret: string,
  type: SealedType,
  sealed: string,
): Promise<T | null> => {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 2) return null;
  const [ivPart, ciphertextPart] = parts;
  if (!ivPart || !ciphertextPart) return null;

  try {
    const key = await cachedDeriveKey(secret, type, "decrypt");
    const iv = fromBase64Url(ivPart);
    if (iv.byteLength !== IV_BYTES) return null;
    const ciphertext = fromBase64Url(ciphertextPart);
    const additionalData = new TextEncoder().encode(type);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
};

/**
 * Rotation-aware unseal: tries each `secrets` entry in order, returning the
 * index of the one that actually worked so a caller can audit "sealed under
 * a non-primary key" without a second decrypt pass. `secrets` is expected
 * non-empty (callers resolve it via `resolveSecrets`, which enforces that).
 */
export const unsealAny = async <T>(
  secrets: readonly string[],
  type: SealedType,
  sealed: string,
): Promise<{ value: T; keyIndex: number } | null> => {
  for (const [keyIndex, secret] of secrets.entries()) {
    const value = await unseal<T>(secret, type, sealed);
    if (value !== null) return { value, keyIndex };
  }
  return null;
};
