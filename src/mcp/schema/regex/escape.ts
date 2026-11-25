import {
  DIGIT,
  invert,
  MAX_CODE_POINT,
  normalize,
  type Ranges,
  SPACE,
  single,
  WORD,
} from "./class.js";

/** A pattern the matcher refuses: unsupported or invalid syntax. The message names the construct. */
export class RegexError extends Error {}

export type Cursor = { chars: string[]; pos: number; names: Set<string> };

const SYNTAX_CHARACTERS = "^$\\.*+?()[]{}|/";
const CONTROL_ESCAPES: Record<string, number> = { t: 9, n: 10, v: 11, f: 12, r: 13 };
const CLASS_ESCAPES: Record<string, Ranges> = {
  d: DIGIT,
  D: invert(DIGIT),
  w: WORD,
  W: invert(WORD),
  s: SPACE,
  S: invert(SPACE),
};
const HEX = /^[0-9a-fA-F]+$/;
const HIGH_SURROGATE = [0xd800, 0xdbff] as const;
const LOW_SURROGATE = [0xdc00, 0xdfff] as const;

export const peek = (c: Cursor, offset = 0): string | undefined => c.chars[c.pos + offset];
const within = (value: number, [low, high]: readonly [number, number]): boolean =>
  value >= low && value <= high;
export const fail = (message: string): never => {
  throw new RegexError(message);
};

const takeHex = (c: Cursor, count: number): number => {
  const digits = c.chars.slice(c.pos, c.pos + count).join("");
  if (digits.length !== count || !HEX.test(digits)) fail("invalid hexadecimal escape");
  c.pos += count;
  return Number.parseInt(digits, 16);
};

const takeBracedHex = (c: Cursor): number => {
  const end = c.chars.indexOf("}", c.pos);
  const digits = end === -1 ? "" : c.chars.slice(c.pos + 1, end).join("");
  if (!HEX.test(digits) || Number.parseInt(digits, 16) > MAX_CODE_POINT) fail("invalid \\u{...}");
  c.pos = end + 1;
  return Number.parseInt(digits, 16);
};

const takeUnicode = (c: Cursor): number => {
  if (peek(c) === "{") return takeBracedHex(c);
  const high = takeHex(c, 4);
  if (!within(high, HIGH_SURROGATE) || peek(c) !== "\\" || peek(c, 1) !== "u") return high;
  const saved = c.pos;
  c.pos += 2;
  const low = peek(c) === "{" ? Number.NaN : takeHex(c, 4);
  if (within(low, LOW_SURROGATE)) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  c.pos = saved;
  return high;
};

/** The escape after a backslash that both contexts share: a code point, or a class escape. */
export const parseCommonEscape = (c: Cursor, char: string): number | Ranges => {
  const control = CONTROL_ESCAPES[char];
  if (control !== undefined) return control;
  const set = CLASS_ESCAPES[char];
  if (set !== undefined) return set;
  if (char === "x") return takeHex(c, 2);
  if (char === "u") return takeUnicode(c);
  if (char === "0" && !/\d/.test(peek(c) ?? "")) return 0;
  if (SYNTAX_CHARACTERS.includes(char)) return char.codePointAt(0) as number;
  if (/[1-9]/.test(char) || char === "k") return fail("unsupported backreference");
  if (char === "p" || char === "P") return fail("unsupported \\p{...} property escape");
  if (char === "c") return fail("unsupported \\c control escape");
  return fail(`invalid escape \\${char}`);
};

export const takeEscapeChar = (c: Cursor): string => {
  const char = c.chars[c.pos];
  if (char === undefined) return fail("pattern ends with a backslash");
  c.pos += 1;
  return char;
};

export const asSet = (value: number | Ranges): Ranges =>
  typeof value === "number" ? single(value) : value;

type ClassItem = number | Ranges;

const parseClassItem = (c: Cursor): ClassItem => {
  const char = c.chars[c.pos++] as string;
  if (char !== "\\") return char.codePointAt(0) as number;
  const escaped = takeEscapeChar(c);
  if (escaped === "b") return 8;
  if (escaped === "-") return 0x2d;
  return parseCommonEscape(c, escaped);
};

export const parseClass = (c: Cursor): Ranges => {
  const negated = peek(c) === "^";
  if (negated) c.pos += 1;
  const pairs: Array<[number, number]> = [];
  while (peek(c) !== "]") {
    if (peek(c) === undefined) fail("unterminated character class");
    const from = parseClassItem(c);
    const isRange = peek(c) === "-" && peek(c, 1) !== "]" && peek(c, 1) !== undefined;
    if (!isRange) {
      pairs.push(...rangesToPairs(asSet(from)));
      continue;
    }
    c.pos += 1;
    const to = parseClassItem(c);
    if (typeof from !== "number" || typeof to !== "number")
      fail("invalid range in character class");
    if ((from as number) > (to as number)) fail("character class range out of order");
    pairs.push([from as number, to as number]);
  }
  c.pos += 1;
  const ranges = normalize(pairs);
  return negated ? invert(ranges) : ranges;
};

const rangesToPairs = (ranges: Ranges): Array<[number, number]> =>
  Array.from({ length: ranges.length / 2 }, (_, at) => [
    ranges[at * 2] as number,
    ranges[at * 2 + 1] as number,
  ]);
