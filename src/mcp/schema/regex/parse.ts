import { DOT, type Ranges, single } from "./class.js";
import {
  asSet,
  type Cursor,
  fail,
  parseClass,
  parseCommonEscape,
  peek,
  RegexError,
  takeEscapeChar,
} from "./escape.js";
import { MAX_REGEX_GROUP_DEPTH, MAX_REGEX_SOURCE_LENGTH } from "./limits.js";

export { RegexError };

export type AssertKind = "start" | "end" | "boundary" | "notBoundary";

export type Node =
  | { kind: "set"; ranges: Ranges }
  | { kind: "cat"; items: Node[] }
  | { kind: "alt"; branches: Node[] }
  | { kind: "repeat"; min: number; max: number; body: Node }
  | { kind: "assert"; type: AssertKind };

const GROUP_NAME = /^[A-Za-z_$][\w$]*$/;
const MAX_REPEAT_DIGITS = 9;
const BRACES = /^\{(\d+)(?:(,)(\d*))?\}/;

const parseEscape = (c: Cursor): Node => {
  const char = takeEscapeChar(c);
  if (char === "b") return { kind: "assert", type: "boundary" };
  if (char === "B") return { kind: "assert", type: "notBoundary" };
  return { kind: "set", ranges: asSet(parseCommonEscape(c, char)) };
};

const parseGroupHead = (c: Cursor): void => {
  if (peek(c) !== "?") return;
  c.pos += 1;
  const next = peek(c);
  if (next === ":") {
    c.pos += 1;
    return;
  }
  if (next === "=" || next === "!") fail("unsupported lookahead");
  if (next === "<" && (peek(c, 1) === "=" || peek(c, 1) === "!")) fail("unsupported lookbehind");
  if (next !== "<") fail("unsupported inline flags or group syntax");
  const end = c.chars.indexOf(">", c.pos);
  const name = end === -1 ? "" : c.chars.slice(c.pos + 1, end).join("");
  if (!GROUP_NAME.test(name) || c.names.has(name)) fail("invalid or repeated group name");
  c.names.add(name);
  c.pos = end + 1;
};

const parseGroup = (c: Cursor, depth: number): Node => {
  if (depth >= MAX_REGEX_GROUP_DEPTH) fail(`groups nested deeper than ${MAX_REGEX_GROUP_DEPTH}`);
  parseGroupHead(c);
  const inner = parseAlternation(c, depth + 1);
  if (peek(c) !== ")") fail("unterminated group");
  c.pos += 1;
  return inner;
};

const parseAtom = (c: Cursor, depth: number): Node => {
  const char = c.chars[c.pos++] as string;
  if (char === "(") return parseGroup(c, depth);
  if (char === "[") return { kind: "set", ranges: parseClass(c) };
  if (char === "\\") return parseEscape(c);
  if (char === ".") return { kind: "set", ranges: DOT };
  if (char === "^") return { kind: "assert", type: "start" };
  if (char === "$") return { kind: "assert", type: "end" };
  if ("*+?{".includes(char)) return fail("nothing to repeat");
  if ("}]".includes(char)) return fail(`unescaped ${char}`);
  return { kind: "set", ranges: single(char.codePointAt(0) as number) };
};

const readCounts = (c: Cursor): { min: number; max: number } | undefined => {
  const char = peek(c);
  if (char === "*" || char === "+" || char === "?") {
    c.pos += 1;
    return { min: char === "+" ? 1 : 0, max: char === "?" ? 1 : Number.POSITIVE_INFINITY };
  }
  if (char !== "{") return undefined;
  const braces = BRACES.exec(c.chars.slice(c.pos, c.pos + 24).join(""));
  if (!braces) return fail("invalid quantifier");
  const [text = "", low = "", comma, high = ""] = braces;
  if (low.length > MAX_REPEAT_DIGITS || high.length > MAX_REPEAT_DIGITS)
    fail("repeat count too large");
  c.pos += text.length;
  const min = Number(low);
  const max = comma === undefined ? min : high === "" ? Number.POSITIVE_INFINITY : Number(high);
  if (min > max) fail("quantifier range out of order");
  return { min, max };
};

const parseTerm = (c: Cursor, depth: number): Node => {
  const atom = parseAtom(c, depth);
  const counts = atom.kind === "assert" ? undefined : readCounts(c);
  if (!counts) return atom;
  if (peek(c) === "?") c.pos += 1;
  return { kind: "repeat", ...counts, body: atom };
};

const parseSequence = (c: Cursor, depth: number): Node => {
  const items: Node[] = [];
  while (c.pos < c.chars.length && peek(c) !== "|" && peek(c) !== ")") {
    items.push(parseTerm(c, depth));
  }
  return { kind: "cat", items };
};

const parseAlternation = (c: Cursor, depth: number): Node => {
  const branches = [parseSequence(c, depth)];
  while (peek(c) === "|") {
    c.pos += 1;
    branches.push(parseSequence(c, depth));
  }
  return branches.length === 1 ? (branches[0] as Node) : { kind: "alt", branches };
};

/** The syntax tree of an ECMAScript pattern (unicode mode); throws `RegexError` for anything outside the supported subset. */
export const parseRegex = (source: string): Node => {
  const chars = Array.from(source);
  if (chars.length > MAX_REGEX_SOURCE_LENGTH) {
    fail(`pattern longer than ${MAX_REGEX_SOURCE_LENGTH} characters`);
  }
  const cursor: Cursor = { chars, pos: 0, names: new Set() };
  const tree = parseAlternation(cursor, 0);
  if (cursor.pos < chars.length) fail("unmatched )");
  return tree;
};
