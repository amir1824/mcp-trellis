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

/** Cleaning reads this many times `max`: a caller can send a megabyte. */
const SCAN_FACTOR = 4;

/**
 * One line, clipped: for caller-chosen text on its way to a log or audit sink.
 * ponytail: only the head is cleaned, so text behind a long run of whitespace or control characters
 * is lost. Clean in a bounded loop if a sink ever needs it.
 */
export const clipLine = (value: string, max: number): string => {
  const head = value.slice(0, max * SCAN_FACTOR);
  const line = head.replace(/\s+/gu, " ").replace(/\p{C}/gu, "");
  const unmarkedCut = head.length < value.length && line.length <= max;
  return unmarkedCut ? `${line}…` : clipText(line, max, "…");
};
