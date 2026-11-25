/**
 * Sets of code points as sorted, disjoint `[low, high, low, high, ...]` pairs, the
 * representation of every single-character matcher: a literal, `.`, `[a-z]`, `\d`.
 */
export type Ranges = readonly number[];

export const MAX_CODE_POINT = 0x10ffff;

const LINE_TERMINATORS: Ranges = [0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029];

/** Sorts and merges `[low, high]` pairs given in any order. */
export const normalize = (pairs: ReadonlyArray<readonly [number, number]>): Ranges => {
  const sorted = [...pairs].sort((left, right) => left[0] - right[0]);
  const merged: number[] = [];
  for (const [low, high] of sorted) {
    const last = merged.length - 1;
    if (last >= 0 && low <= (merged[last] as number) + 1) {
      merged[last] = Math.max(merged[last] as number, high);
      continue;
    }
    merged.push(low, high);
  }
  return merged;
};

/** Every code point not in `ranges`. */
export const invert = (ranges: Ranges): Ranges => {
  const gaps: Array<[number, number]> = [];
  let next = 0;
  for (let at = 0; at < ranges.length; at += 2) {
    if ((ranges[at] as number) > next) gaps.push([next, (ranges[at] as number) - 1]);
    next = (ranges[at + 1] as number) + 1;
  }
  if (next <= MAX_CODE_POINT) gaps.push([next, MAX_CODE_POINT]);
  return gaps.flat();
};

export const single = (codePoint: number): Ranges => [codePoint, codePoint];

export const DIGIT: Ranges = [0x30, 0x39];
export const WORD: Ranges = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
/** ECMAScript WhiteSpace and LineTerminator. */
export const SPACE: Ranges = [
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
  0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff,
];
/** `.` without the `s` flag. */
export const DOT: Ranges = invert(LINE_TERMINATORS);

/** Binary search; `ranges` are sorted and disjoint. */
export const contains = (ranges: Ranges, codePoint: number): boolean => {
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codePoint < (ranges[middle * 2] as number)) high = middle - 1;
    else if (codePoint > (ranges[middle * 2 + 1] as number)) low = middle + 1;
    else return true;
  }
  return false;
};

export const isWordCodePoint = (codePoint: number): boolean => contains(WORD, codePoint);
