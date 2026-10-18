/**
 * `record[key]` for an attacker-supplied `key`: only an own property counts.
 * A plain object literal also answers `"constructor"`, `"toString"` and
 * `"__proto__"` from `Object.prototype`, which would otherwise be mistaken
 * for a registered handler.
 */
export const ownValue = <V>(record: Readonly<Record<string, V>>, key: string): V | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;
