/**
 * A small bounded cache for the derived `CryptoKey`s `sealed.ts` and
 * `secrethash.ts` compute via HKDF — every `seal`/`unseal`/`hashClientSecret`
 * call otherwise re-runs `importKey` + `deriveKey` from scratch, and key
 * rotation (`unsealAny`/`verifyClientSecretAny`) can multiply that by the
 * number of configured `codeSecret` entries on every request.
 *
 * Insertion-order eviction, not true LRU — simpler, and the expected key
 * count (a handful of rotation entries, rarely changing at runtime) stays
 * well under the cap in ordinary use, so eviction order rarely matters in
 * practice. The cap itself exists for the discouraged-but-possible case of
 * a function-form `codeSecret` returning a different value on every call,
 * which would otherwise grow this cache without bound.
 */
export const createBoundedCache = <V>(
  limit: number,
): {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
} => {
  const map = new Map<string, V>();
  return {
    get: (key) => map.get(key),
    set: (key, value) => {
      if (!map.has(key) && map.size >= limit) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    },
  };
};
