/** `keys` of `T` with `undefined` removed from each value type, all optional. */
export type DefinedProps<T, K extends keyof T> = { [P in K]?: Exclude<T[P], undefined> };

/**
 * Copies only the listed keys whose value is not `undefined`. Under
 * `exactOptionalPropertyTypes` an explicit `undefined` is not assignable to
 * an optional property, so forwarding optional options needs exactly this.
 */
export const pickDefined = <T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): DefinedProps<T, K> => {
  const picked: DefinedProps<T, K> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) picked[key] = value as Exclude<T[K], undefined>;
  }
  return picked;
};
