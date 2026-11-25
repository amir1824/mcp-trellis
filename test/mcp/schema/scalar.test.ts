import { describe } from "node:test";
import { checkRows, type Row } from "./rows.js";

const TYPE_ROWS: Row[] = [
  [
    "type: integer accepts 1.0 (JSON-Schema-Test-Suite 'a float with zero fractional part is an integer')",
    { type: "integer" },
    1.0,
    [],
  ],
  ["type: integer rejects 1.5", { type: "integer" }, 1.5, ["args: expected integer, got number"]],
  [
    "type: number rejects Infinity (JSON.parse of 1e999)",
    { type: "number" },
    JSON.parse("1e999"),
    ["args: expected number, got non-finite number"],
  ],
  [
    "type: integer rejects -Infinity",
    { type: "integer" },
    JSON.parse("-1e999"),
    ["args: expected integer, got non-finite number"],
  ],
  [
    "type: number rejects NaN",
    { type: "number" },
    Number.NaN,
    ["args: expected number, got non-finite number"],
  ],
  ["type: union accepts a member", { type: ["string", "null"] }, null, []],
  [
    "type: union rejects a non-member",
    { type: ["string", "null"] },
    3,
    ["args: expected string | null, got number"],
  ],
  ["type: string rejects an array", { type: "string" }, [], ["args: expected string, got array"]],
];

const ENUM_CONST_ROWS: Row[] = [
  ["enum accepts a member", { enum: ["a", 2] }, 2, []],
  ["enum rejects a non-member", { enum: ["a", 2] }, "b", ["args: value not in enum"]],
  ["enum with false does not match 0 (suite)", { enum: [false] }, 0, ["args: value not in enum"]],
  [
    "const accepts an equal object, key order ignored",
    { const: { a: 1, b: [2] } },
    { b: [2], a: 1 },
    [],
  ],
  [
    "const rejects a different value",
    { const: { a: 1 } },
    { a: 2 },
    ["args: value does not equal const"],
  ],
  ["const null accepts null", { const: null }, null, []],
  ["const null rejects 0", { const: null }, 0, ["args: value does not equal const"]],
];

const NUMBER_ROWS: Row[] = [
  ["exclusiveMinimum accepts above", { exclusiveMinimum: 1 }, 1.1, []],
  [
    "exclusiveMinimum rejects the bound itself",
    { exclusiveMinimum: 1 },
    1,
    ["args: not above exclusiveMinimum 1"],
  ],
  ["exclusiveMaximum accepts below", { exclusiveMaximum: 3 }, 2.9, []],
  [
    "exclusiveMaximum rejects the bound itself",
    { exclusiveMaximum: 3 },
    3,
    ["args: not below exclusiveMaximum 3"],
  ],
  ["minimum accepts the bound itself", { minimum: 1.1 }, 1.1, []],
  ["maximum rejects above", { maximum: 3 }, 3.5, ["args: above maximum 3"]],
  ["ignores bounds for a non-number", { minimum: 5 }, "a", []],
  ["multipleOf accepts 4.5 by 1.5", { multipleOf: 1.5 }, 4.5, []],
  ["multipleOf accepts 0.3 by 0.1 despite binary rounding", { multipleOf: 0.1 }, 0.3, []],
  [
    "multipleOf accepts 0.0075 by 0.0001 (suite 'by small number')",
    { multipleOf: 0.0001 },
    0.0075,
    [],
  ],
  [
    "multipleOf rejects 0.00751 by 0.0001",
    { multipleOf: 0.0001 },
    0.00751,
    ["args: not a multiple of 0.0001"],
  ],
  ["multipleOf rejects 7 by 2", { multipleOf: 2 }, 7, ["args: not a multiple of 2"]],
  [
    "multipleOf with an infinite quotient is not a multiple (suite 'float division = inf')",
    { type: "integer", multipleOf: 0.123456789 },
    1e308,
    ["args: not a multiple of 0.123456789"],
  ],
  [
    "multipleOf 1 rejects a large value with a tiny fraction",
    { multipleOf: 1 },
    600_000_000.0000005,
    ["args: not a multiple of 1"],
  ],
  ["multipleOf 1 accepts a large integer", { multipleOf: 1 }, 600_000_000, []],
  ["multipleOf 7 accepts 49", { multipleOf: 7 }, 49, []],
  ["multipleOf rejects 0.5 by 1", { multipleOf: 1 }, 0.5, ["args: not a multiple of 1"]],
];

const STRING_ROWS: Row[] = [
  [
    "minLength counts code points: one emoji is long enough for 1 (suite)",
    { minLength: 1 },
    "\u{1F4A9}",
    [],
  ],
  [
    "minLength: one emoji is too short for 2 (suite)",
    { minLength: 2 },
    "\u{1F4A9}",
    ["args: shorter than minLength 2"],
  ],
  ["maxLength: two emoji fit 2 (suite)", { maxLength: 2 }, "\u{1F4A9}\u{1F4A9}", []],
  [
    "maxLength rejects 3 characters for 2",
    { maxLength: 2 },
    "abc",
    ["args: longer than maxLength 2"],
  ],
  ["pattern accepts a match", { pattern: "^[A-Z]{3}$" }, "ABC", []],
  ["pattern is not implicitly anchored (suite)", { pattern: "a+" }, "xxaayy", []],
  [
    "pattern rejects a mismatch without echoing the value",
    { pattern: "^[A-Z]{3}$" },
    "abc",
    ["args: does not match pattern ^[A-Z]{3}$"],
  ],
  ["pattern uses unicode mode: \\u{1F4A9} is one code point", { pattern: "^.$" }, "\u{1F4A9}", []],
  ["pattern is ignored for a non-string", { pattern: "^a$" }, 5, []],
  ["format is an annotation, never an assertion", { format: "email" }, "not-an-email", []],
];

describe("type", () => checkRows(TYPE_ROWS));
describe("enum and const", () => checkRows(ENUM_CONST_ROWS));
describe("numbers", () => checkRows(NUMBER_ROWS));
describe("strings", () => checkRows(STRING_ROWS));
