/**
 * The first `max` UTF-16 units of `value`, without leaving half a surrogate
 * pair at the cut — a lone surrogate is invalid in JSON and many DB sinks.
 * `suffix` is appended only when something was cut.
 */
export const clipText = (value: string, max: number, suffix = ""): string => {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${value.slice(0, cut)}${suffix}`;
};
