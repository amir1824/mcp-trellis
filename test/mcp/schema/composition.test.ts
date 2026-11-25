// biome-ignore-all lint/suspicious/noThenProperty: `then` is a JSON Schema keyword here, not a thenable
import { describe } from "node:test";
import { checkRows, type Row } from "./rows.js";

const ALL_ANY_ROWS: Row[] = [
  [
    "allOf accepts when every branch matches",
    { allOf: [{ type: "number" }, { minimum: 1 }] },
    2,
    [],
  ],
  [
    "allOf reports the failing branch",
    { allOf: [{ type: "number" }, { minimum: 5 }] },
    2,
    ["args: below minimum 5"],
  ],
  [
    "allOf with one false branch fails (suite)",
    { allOf: [{}, false] },
    1,
    ["args: no value is allowed"],
  ],
  [
    "anyOf accepts when one branch matches",
    { anyOf: [{ type: "string" }, { type: "number" }] },
    1,
    [],
  ],
  [
    "anyOf rejects when none match",
    { anyOf: [{ type: "string" }, { type: "number" }] },
    true,
    ["args: does not match any schema in anyOf"],
  ],
  [
    "anyOf of required branches is the usual 'at least one of' idiom",
    { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] },
    { b: 1 },
    [],
  ],
  [
    "anyOf of required branches rejects neither",
    { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] },
    {},
    ["args: does not match any schema in anyOf"],
  ],
];

const ONE_NOT_ROWS: Row[] = [
  [
    "oneOf accepts exactly one match",
    { oneOf: [{ type: "string" }, { type: "number", minimum: 3 }] },
    "a",
    [],
  ],
  [
    "oneOf rejects two matches",
    { oneOf: [{ type: "number" }, { minimum: 3 }] },
    4,
    ["args: matches more than one schema in oneOf"],
  ],
  [
    "oneOf rejects no match",
    { oneOf: [{ type: "string" }, { type: "boolean" }] },
    4,
    ["args: does not match any schema in oneOf"],
  ],
  ["not accepts a non-match", { not: { type: "string" } }, 1, []],
  [
    "not rejects a match",
    { not: { type: "string" } },
    "a",
    ["args: must not match the schema in not"],
  ],
  [
    "not: true rejects everything (suite)",
    { not: true },
    1,
    ["args: must not match the schema in not"],
  ],
];

const CONDITIONAL_ROWS: Row[] = [
  [
    "if/then applies then when if matches",
    { if: { minimum: 10 }, then: { multipleOf: 5 } },
    12,
    ["args: not a multiple of 5"],
  ],
  ["if/then skips then when if fails", { if: { minimum: 10 }, then: { multipleOf: 5 } }, 3, []],
  [
    "if/else applies else when if fails",
    { if: { minimum: 10 }, else: { maximum: 5 } },
    7,
    ["args: above maximum 5"],
  ],
  ["then without if is ignored (suite)", { then: false }, 1, []],
  ["else without if is ignored (suite)", { else: false }, 1, []],
  ["if without then or else has no effect (suite)", { if: false }, 1, []],
  [
    "if with properties and then required",
    {
      if: { properties: { kind: { const: "a" } }, required: ["kind"] },
      then: { required: ["extra"] },
    },
    { kind: "a" },
    ["args.extra: required"],
  ],
];

const BOOLEAN_ROWS: Row[] = [
  ["a true property schema accepts anything", { properties: { a: true } }, { a: 1 }, []],
  [
    "a false property schema rejects a present key",
    { properties: { a: false } },
    { a: 1 },
    ["args.a: no value is allowed"],
  ],
];

describe("allOf and anyOf", () => checkRows(ALL_ANY_ROWS));
describe("oneOf and not", () => checkRows(ONE_NOT_ROWS));
describe("if, then, else", () => checkRows(CONDITIONAL_ROWS));
describe("boolean schemas", () => checkRows(BOOLEAN_ROWS));
