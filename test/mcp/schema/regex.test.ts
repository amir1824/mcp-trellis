import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_EVALUATION_STEPS, MAX_PATTERN_INPUT_LENGTH } from "../../../src/mcp/schema/limits.js";
import {
  MAX_REGEX_GROUP_DEPTH,
  MAX_REGEX_PROGRAM_SIZE,
  MAX_REGEX_SOURCE_LENGTH,
} from "../../../src/mcp/schema/regex/limits.js";
import { compilePattern } from "../../../src/mcp/schema/regex/pattern.js";
import { matchesProgram } from "../../../src/mcp/schema/regex/run.js";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";
import { ROWS } from "./regex-rows.js";

/** Matches with the library's matcher; an unsupported pattern throws, which fails the test. */
const matchesRegex = (pattern: string, input: string): boolean => {
  const compiled = compilePattern(pattern);
  assert.ok(!("problem" in compiled), `${pattern} is not supported`);
  return matchesProgram(compiled.program, input);
};

const problemOf = (pattern: string): string => {
  const compiled = compilePattern(pattern);
  return "problem" in compiled ? compiled.problem : "";
};

const MAX = MAX_PATTERN_INPUT_LENGTH;
const A = "a".repeat(MAX);

describe("the matcher agrees with RegExp(source, 'u').test", () => {
  ROWS.forEach(([pattern, input, expected]) => {
    it(`${JSON.stringify(pattern)} on ${JSON.stringify(input)}`, () => {
      assert.equal(matchesRegex(pattern, input), expected);
      assert.equal(matchesRegex(pattern, input), new RegExp(pattern, "u").test(input));
    });
  });
});

const CATASTROPHIC_FOR_BACKTRACKING: Array<[pattern: string, input: string]> = [
  ["(a+)+$", `${A}!`],
  ["(\\w|a)+$", `${A}!`],
  ["^(\\w|\\d)*$", `${"1".repeat(MAX)}!`],
  ["^(a|[a])*$", `${A}!`],
  ["\\u{41}(a+)+$", `A${A.slice(2)}!`],
  [`^${"(?:a|a)".repeat(30)}b`, `${"a".repeat(30)}c`],
  ["^(?:A|\\x41A)+$", `${"A".repeat(MAX)}!`],
  ["^(?:a|aa)+$", `${A}c`],
  [".*a.*a.*b", A],
  ["^[a-z0-9]+(?:-[a-z0-9]+)*$", `${"a-".repeat(MAX / 2)}!`],
  ["^\\d{1,3}(,\\d{3})*$", `1${",111".repeat(MAX / 4)}!`],
  ["^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", `${"a@".repeat(MAX / 2)}!`],
  ["^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", `${"0".repeat(MAX)}-`],
  ["^\\d{4}-\\d{2}-\\d{2}$", `${"1".repeat(MAX)}-`],
  ["(?:a?){100}a{100}", "a".repeat(99)],
];

describe("shapes that make a backtracking engine hang finish at the maximum input length", () => {
  CATASTROPHIC_FOR_BACKTRACKING.forEach(([pattern, input]) => {
    it(pattern.slice(0, 50), { timeout: 5000 }, () => {
      assert.equal(matchesRegex(pattern, input), false);
    });
  });

  it("matches a slug and a thousands string that are valid", () => {
    assert.deepEqual(
      [
        matchesRegex("^[a-z0-9]+(?:-[a-z0-9]+)*$", "abc-123-x"),
        matchesRegex("^\\d{1,3}(,\\d{3})*$", "1,234,567"),
      ],
      [true, true],
    );
  });
});

const REFUSED: Array<[pattern: string, fragment: string]> = [
  ["(a)\\1", "backreference"],
  ["(?<n>a)\\k<n>", "backreference"],
  ["(?=a)", "lookahead"],
  ["(?!a)", "lookahead"],
  ["(?<=a)", "lookbehind"],
  ["(?<!a)", "lookbehind"],
  ["\\p{L}", "\\p{...}"],
  ["\\P{L}", "\\p{...}"],
  ["(?i:a)", "inline flags"],
  ["(?i)a", "inline flags"],
  ["(?<n>a)(?<n>b)", "group name"],
  ["(a", "unterminated group"],
  ["a)", "unmatched )"],
  ["[a", "unterminated character class"],
  ["*a", "nothing to repeat"],
  ["a**", "nothing to repeat"],
  ["^*", "nothing to repeat"],
  ["a{2", "invalid quantifier"],
  ["{", "nothing to repeat"],
  ["a{3,2}", "out of order"],
  ["a{1000000000}", "repeat count too large"],
  ["[z-a]", "out of order"],
  ["[\\d-z]", "invalid range"],
  ["[\\B]", "invalid escape"],
  ["\\q", "invalid escape \\q"],
  ["\\-", "invalid escape"],
  ["\\", "backslash"],
  ["\\cA", "control escape"],
  ["\\u{110000}", "\\u{...}"],
  ["\\xZ1", "hexadecimal"],
  ["}", "unescaped }"],
  ["]", "unescaped ]"],
  ["a".repeat(MAX_REGEX_SOURCE_LENGTH + 1), `longer than ${MAX_REGEX_SOURCE_LENGTH}`],
];

const HOSTILE: Array<[pattern: string, fragment: string]> = [
  [
    `${"(".repeat(MAX_REGEX_GROUP_DEPTH + 1)}a${")".repeat(MAX_REGEX_GROUP_DEPTH + 1)}`,
    "nested deeper",
  ],
  ["(".repeat(MAX_REGEX_SOURCE_LENGTH), "nested deeper"],
  ["(".repeat(100_000), `longer than ${MAX_REGEX_SOURCE_LENGTH}`],
  ["a{0,9999}", `${MAX_REGEX_PROGRAM_SIZE} instructions`],
  ["(?:a{1000}){1000}", `${MAX_REGEX_PROGRAM_SIZE} instructions`],
  ["(?:a?){999999999}", `${MAX_REGEX_PROGRAM_SIZE} instructions`],
  [".{0,9999}a.{0,9999}a.{0,9999}b", `${MAX_REGEX_PROGRAM_SIZE} instructions`],
  ["[abc", "unterminated character class"],
];

describe("unsupported syntax is refused, never partly accepted", () => {
  REFUSED.concat(HOSTILE).forEach(([pattern, fragment]) => {
    it(`${JSON.stringify(pattern.slice(0, 40))} names ${fragment}`, { timeout: 2000 }, () => {
      assert.equal(problemOf(pattern).includes(fragment), true, problemOf(pattern));
    });
  });

  it("an empty repeated body compiles without looping a billion times", { timeout: 2000 }, () => {
    assert.equal(problemOf("(?:){999999999}"), "");
  });
});

describe("matching is charged to the step budget", () => {
  it("20,000 strings of the maximum length abort the validation, fail closed", {
    timeout: 10_000,
  }, () => {
    const errors = validateAgainstSchema(
      Array.from({ length: 20_000 }, () => A),
      { items: { pattern: "^[a-z]+$" } },
    );
    assert.equal(errors.length, 1);
    assert.match(
      errors[0] ?? "",
      new RegExp(`validation stopped after ${MAX_EVALUATION_STEPS} steps`),
    );
  });

  it("20,000 long property names abort a patternProperties walk", { timeout: 10_000 }, () => {
    const keys = Object.fromEntries(
      Array.from({ length: 20_000 }, (_, at) => [`${at}${"k".repeat(1000)}`, 1]),
    );
    const errors = validateAgainstSchema(keys, { patternProperties: { "^k": {} } });
    assert.match(errors.join(), /validation stopped after/);
  });

  it("a string over the input bound is a violation and is never matched", () => {
    assert.deepEqual(validateAgainstSchema(`${A}a`, { pattern: "^a+$" }), [
      `args: string longer than ${MAX} code units cannot be matched against a pattern`,
    ]);
  });
});
