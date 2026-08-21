/**
 * Production-shaped CodeStore + revocation denylist against a minimal
 * TTL kv interface. Typechecked only — no Redis/KV client in this repo.
 *
 * Wire-ups that satisfy `Kv`:
 * - Redis: GET / SET EX / SET NX EX / DEL
 * - Postgres: row with expires_at; INSERT … ON CONFLICT DO NOTHING for NX
 * - Workers KV: get/put/delete with expirationTtl — but **no atomic NX**.
 *   Auth-code single-use needs D1 or a Durable Object, not Workers KV alone.
 */

import type { CodeStore } from "../src/oauth/codes.js";

/** Minimal TTL key-value surface shared stores need. */
export type Kv = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<void>;
  /**
   * Atomic SET NX EX — return false if the key already existed.
   * Required for single-use auth codes (Redis `SET NX EX`, Postgres
   * `INSERT … ON CONFLICT DO NOTHING`).
   */
  setIfAbsent: (key: string, value: string, ttlSeconds: number) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
};

/** Process-local Kv for demos and tests. */
export const memoryKv = (): Kv => {
  const rows = new Map<string, { value: string; expMs: number }>();
  const read = (key: string): string | null => {
    const row = rows.get(key);
    if (!row) return null;
    if (row.expMs < Date.now()) {
      rows.delete(key);
      return null;
    }
    return row.value;
  };
  return {
    get: async (key) => read(key),
    set: async (key, value, ttlSeconds) => {
      rows.set(key, { value, expMs: Date.now() + ttlSeconds * 1000 });
    },
    setIfAbsent: async (key, value, ttlSeconds) => {
      if (read(key) !== null) return false;
      rows.set(key, { value, expMs: Date.now() + ttlSeconds * 1000 });
      return true;
    },
    delete: async (key) => {
      rows.delete(key);
    },
  };
};

/** Single-use auth-code jti store — one atomic setIfAbsent per consume. */
export const kvCodeStore = (kv: Kv): CodeStore => ({
  consume: async (jti, expMs) => {
    const ttlSeconds = Math.max(1, Math.ceil((expMs - Date.now()) / 1000));
    return kv.setIfAbsent(`code:${jti}`, "1", ttlSeconds);
  },
});

/** Revocation denylist — verifyToken / refreshAccessToken must consult it. */
export const kvRevocation = (kv: Kv) => ({
  revoke: async (token: string, ttlSeconds = 86_400) => {
    await kv.set(`revoked:${token}`, "1", ttlSeconds);
  },
  isRevoked: async (token: string) => (await kv.get(`revoked:${token}`)) !== null,
});
