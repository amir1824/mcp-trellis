import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_EVALUATION_DEPTH,
  MAX_EVALUATION_STEPS,
  MAX_PATTERN_INPUT_LENGTH,
  MAX_REF_DEPTH,
  MAX_UNIQUE_ITEMS,
  MAX_VALIDATION_ERRORS,
} from "../../../src/mcp/schema/limits.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";
import { checkRows, type Row } from "./rows.js";

const nestArray = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>((inner) => [inner], []);

const nestItems = (levels: number): JsonSchema =>
  Array.from({ length: levels }).reduce<JsonSchema>((inner) => ({ items: inner }), {});

/** `a0` accepts anything; each `aN` is `allOf` of two `$ref`s to `aN-1`: 2^N evaluations. */
const bomb = (levels: number): JsonSchema => ({
  $defs: Object.fromEntries([
    ["a0", {}],
    ...Array.from({ length: levels }, (_, i) => [
      `a${i + 1}`,
      { allOf: [{ $ref: `#/$defs/a${i}` }, { $ref: `#/$defs/a${i}` }] },
    ]),
  ]),
  $ref: `#/$defs/a${levels}`,
});

/** A recursive node whose `child` is `allOf` of two `$ref`s to itself: 2^N visits of the leaf. */
const NODE_BOMB: JsonSchema = {
  $defs: {
    node: {
      type: "object",
      properties: { child: { allOf: [{ $ref: "#/$defs/node" }, { $ref: "#/$defs/node" }] } },
    },
  },
  $ref: "#/$defs/node",
};

const wideLeaf = (levels: number): unknown =>
  Array.from({ length: levels }).reduce<unknown>(
    (inner) => ({ child: inner }),
    Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, 1])),
  );

const LONG = "a".repeat(MAX_PATTERN_INPUT_LENGTH + 1);
const TOO_LONG = `string longer than ${MAX_PATTERN_INPUT_LENGTH} code units cannot be matched against a pattern`;

const PATTERN_ROWS: Row[] = [
  [
    "input guard: a string over the cap is a violation for a linear pattern",
    { pattern: "^a+$" },
    `${LONG}!`,
    [`args: ${TOO_LONG}`],
  ],
  [
    "a string at the length bound is still matched",
    { pattern: "^a+$" },
    "a".repeat(MAX_PATTERN_INPUT_LENGTH),
    [],
  ],
  [
    "fail closed inside not: an over-long string never passes `not pattern`",
    { not: { pattern: "^admin" } },
    `admin${LONG}`,
    [`args: ${TOO_LONG}`],
  ],
  [
    "fail closed inside anyOf",
    { anyOf: [{ pattern: "^x" }, { pattern: "^y" }] },
    LONG,
    [`args: ${TOO_LONG}`],
  ],
  ["fail closed inside if", { if: { pattern: "^a" }, else: false }, LONG, [`args: ${TOO_LONG}`]],
  [
    "an over-long property name against patternProperties",
    { patternProperties: { "^a": {} } },
    { [LONG]: 1 },
    [`args.${"a".repeat(64)}…: ${TOO_LONG}`],
  ],
  [
    "an over-long property name against propertyNames pattern",
    { propertyNames: { pattern: "^a" } },
    { [LONG]: 1 },
    [`args: ${TOO_LONG}`],
  ],
  ["a long string without any pattern is not limited", { maxLength: 5000 }, LONG, []],
];

const DEPTH_ROWS: Row[] = [
  [
    "a $ref recursion over deep data ends at the $ref bound",
    { type: "array", items: { $ref: "#" } },
    nestArray(100),
    [`args${"[0]".repeat(MAX_REF_DEPTH + 1)}: $ref nested deeper than ${MAX_REF_DEPTH} levels`],
  ],
  [
    "a 100000-deep value does not overflow the stack",
    { type: "array", items: { $ref: "#" } },
    nestArray(100_000),
    [`args${"[0]".repeat(MAX_REF_DEPTH + 1)}: $ref nested deeper than ${MAX_REF_DEPTH} levels`],
  ],
  [
    "a deep schema without $ref ends at the evaluation depth bound",
    nestItems(MAX_EVALUATION_DEPTH + 10),
    nestArray(MAX_EVALUATION_DEPTH + 10),
    [
      `args${"[0]".repeat(MAX_EVALUATION_DEPTH + 1)}: nested deeper than ${MAX_EVALUATION_DEPTH} levels`,
    ],
  ],
  [
    "a recursive $ref within the bounds validates",
    { type: "array", items: { $ref: "#" } },
    nestArray(20),
    [],
  ],
];

const STEP_ROWS: Row[] = [
  [
    "a schema bomb (2^25 evaluations) stops at the step bound",
    bomb(25),
    1,
    [`args: validation stopped after ${MAX_EVALUATION_STEPS} steps`],
  ],
  ["a small amplification is evaluated normally", bomb(5), 1, []],
  [
    "a flat 500k-element array (the 1 MiB body limit) is within the step bound",
    { type: "array", items: { type: "number" } },
    Array.from({ length: 500_000 }, () => 1),
    [],
  ],
];

const COST_ROWS: Row[] = [
  [
    "a recursive bomb over a 50k-key leaf is charged for the keys it visits",
    NODE_BOMB,
    wideLeaf(17),
    [
      `args.child.child.child.child.child.child.child.child.child.child.child.child.child.child.child.child.child: validation stopped after ${MAX_EVALUATION_STEPS} steps`,
    ],
  ],
  [
    "a long string under maxLength is not scanned or charged",
    { maxLength: 5000 },
    "a".repeat(4096),
    [],
  ],
  [
    "minLength decides from UTF-16 length alone when the string is long enough",
    { minLength: 3 },
    "abcdef",
    [],
  ],
  [
    "maxLength counts code points when the UTF-16 length is ambiguous",
    { maxLength: 2 },
    "\u{1F4A9}\u{1F4A9}\u{1F4A9}",
    ["args: longer than maxLength 2"],
  ],
  [
    "prefixItems alone does not walk the rest of the array",
    { prefixItems: [{ type: "number" }] },
    [1, ...Array.from({ length: 499_999 }, () => "x")],
    [],
  ],
];

const UNIQUE_ROWS: Row[] = [
  [
    "uniqueItems compares up to the item bound",
    { uniqueItems: true },
    Array.from({ length: MAX_UNIQUE_ITEMS }, (_, i) => i),
    [],
  ],
  [
    "uniqueItems over the item bound is a violation",
    { uniqueItems: true },
    Array.from({ length: MAX_UNIQUE_ITEMS + 1 }, (_, i) => i),
    [`args: more than ${MAX_UNIQUE_ITEMS} items cannot be checked for uniqueness`],
  ],
  [
    "uniqueItems over deeply nested items is a violation, not a stack overflow",
    { uniqueItems: true },
    [nestArray(100_000), nestArray(100_000)],
    [`args: items nested deeper than ${MAX_EVALUATION_DEPTH} levels cannot be compared`],
  ],
];

const UNCHECKED_ROWS: Row[] = [
  [
    "a schema never checked at construction fails closed: invalid regex",
    { pattern: "(" },
    "a",
    [
      "args: schema keyword pattern (unsupported regex syntax for pattern: unterminated group; simplify it or pass a schemaValidator) is not supported",
    ],
  ],
  [
    "a schema never checked at construction fails closed: remote $ref",
    { $ref: "https://example.com/s" },
    1,
    ["args: schema keyword $ref (non-local $ref) is not supported"],
  ],
  [
    "a schema never checked at construction fails closed: unresolved $ref",
    { $ref: "#/$defs/nope" },
    1,
    ["args: unresolved $ref #/$defs/nope"],
  ],
];

describe("pattern input bound (ReDoS guard)", () => checkRows(PATTERN_ROWS));
describe("depth bounds", () => checkRows(DEPTH_ROWS));
describe("step bound", () => checkRows(STEP_ROWS));
describe("work is charged by size, not only by visit", () => checkRows(COST_ROWS));
describe("uniqueItems bounds", () => checkRows(UNIQUE_ROWS));
describe("unchecked schemas", () => checkRows(UNCHECKED_ROWS));

describe("violation cap", () => {
  const errors = validateAgainstSchema(
    Array.from({ length: 50 }, () => 1),
    { items: { type: "string" } },
  );

  it("reports MAX_VALIDATION_ERRORS violations plus the marker", () => {
    assert.equal(errors.length, MAX_VALIDATION_ERRORS + 1);
  });

  it("ends with the stopped-after marker", () => {
    assert.equal(errors.at(-1), `(stopped after ${MAX_VALIDATION_ERRORS} errors; more may follow)`);
  });

  it("never echoes the offending value", () => {
    const secret = validateAgainstSchema("super-secret-value", { type: "number", maxLength: 3 });
    assert.deepEqual(secret, ["args: expected number, got string"]);
  });
});
