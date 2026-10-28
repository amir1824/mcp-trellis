/** A parsed JSON object — not `null`, not an array. */
export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * True when two JSON values match structurally (object key order ignored).
 * ponytail: assumes acyclic JSON-parsed inputs; upgrade = depth/cycle guard.
 */
export const areJsonValuesEqual = (value: unknown, other: unknown): boolean => {
  // `===` (not `Object.is`): JSON `-0` must still equal `0`, as `enum.includes` always did.
  if (value === other) return true;
  if (Array.isArray(value) || Array.isArray(other)) {
    return (
      Array.isArray(value) &&
      Array.isArray(other) &&
      value.length === other.length &&
      value.every((item, index) => areJsonValuesEqual(item, other[index]))
    );
  }
  if (!isJsonObject(value) || !isJsonObject(other)) return false;

  const valueKeys = Object.keys(value);
  const otherKeys = Object.keys(other);
  return (
    valueKeys.length === otherKeys.length &&
    valueKeys.every(
      (key) => Object.hasOwn(other, key) && areJsonValuesEqual(value[key], other[key]),
    )
  );
};
