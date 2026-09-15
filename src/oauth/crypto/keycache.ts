/**
 * A small bounded cache, used by `hkdf.ts` for derived `CryptoKey`s.
 *
 * Insertion-order eviction, not true LRU — simpler, and the expected key
 * count (a handful of rotation entries, rarely changing at runtime) stays
 * well under the cap in ordinary use, so eviction order rarely matters in
 * practice. The cap itself exists for the discouraged-but-possible case of
 * a function-form `codeSecret` returning a different value on every call,
 * which would otherwise grow this cache without bound.
 */

export type BoundedCache<V> = {
  get: (key: string) => V | undefined;
  set: (key: string, value: V) => void;
  delete: (key: string) => void;
};

export const createBoundedCache = <V>(limit: number): BoundedCache<V> => {
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
    delete: (key) => {
      map.delete(key);
    },
  };
};

/** Cache a promise; drop the entry if it rejects so the slot is not poisoned. */
export const settleCached = async <T>(
  cache: BoundedCache<Promise<T>>,
  key: string,
  create: () => Promise<T>,
): Promise<T> => {
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = create();
  cache.set(key, pending);
  try {
    return await pending;
  } catch (caught) {
    if (cache.get(key) === pending) cache.delete(key);
    throw caught;
  }
};
