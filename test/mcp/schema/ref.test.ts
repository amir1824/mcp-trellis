import { describe } from "node:test";
import { checkRows, type Row } from "./rows.js";

const DEFS = { positive: { type: "integer", minimum: 1 }, text: { type: "string" } };

const REF_ROWS: Row[] = [
  [
    "$ref to $defs validates against the target",
    { $defs: DEFS, properties: { a: { $ref: "#/$defs/positive" } } },
    { a: 0 },
    ["args.a: below minimum 1"],
  ],
  [
    "$ref to $defs accepts a valid value",
    { $defs: DEFS, properties: { a: { $ref: "#/$defs/positive" } } },
    { a: 3 },
    [],
  ],
  [
    "$ref siblings still apply (2020-12)",
    { $defs: DEFS, $ref: "#/$defs/text", maxLength: 2 },
    "abc",
    ["args: longer than maxLength 2"],
  ],
  [
    "$ref to a subschema position by pointer",
    { properties: { a: { type: "string" }, b: { $ref: "#/properties/a" } } },
    { b: 1 },
    ["args.b: expected string, got number"],
  ],
  [
    "$ref to a false subschema rejects",
    { $defs: { no: false }, properties: { a: { $ref: "#/$defs/no" } } },
    { a: 1 },
    ["args.a: no value is allowed"],
  ],
  [
    "$ref # recurses into the root (tree)",
    { type: "object", properties: { n: { type: "number" }, child: { $ref: "#" } } },
    { child: { child: { n: "x" } } },
    ["args.child.child.n: expected number, got string"],
  ],
  [
    "$ref with ~1 escape names a key containing a slash",
    { $defs: { "a/b": DEFS.text }, properties: { x: { $ref: "#/$defs/a~1b" } } },
    { x: 1 },
    ["args.x: expected string, got number"],
  ],
  [
    "$ref with ~0 escape names a key containing a tilde",
    { $defs: { "m~n": DEFS.text }, properties: { x: { $ref: "#/$defs/m~0n" } } },
    { x: 1 },
    ["args.x: expected string, got number"],
  ],
  [
    "$ref percent-decodes the fragment (suite 'percent-encoded')",
    { $defs: { "a b": DEFS.text }, properties: { x: { $ref: "#/$defs/a%20b" } } },
    { x: 1 },
    ["args.x: expected string, got number"],
  ],
  [
    "$ref to a $anchor",
    {
      $defs: { count: { $anchor: "count", type: "integer" } },
      properties: { n: { $ref: "#count" } },
    },
    { n: 1.5 },
    ["args.n: expected integer, got number"],
  ],
  [
    "$ref in items",
    { $defs: DEFS, items: { $ref: "#/$defs/positive" } },
    [1, 0],
    ["args[1]: below minimum 1"],
  ],
];

const CYCLE_ROWS: Row[] = [
  [
    "a $ref cycle that never consumes input terminates with a bound message",
    { $ref: "#" },
    1,
    ["args: $ref nested deeper than 32 levels"],
  ],
  [
    "a mutual $ref cycle terminates",
    { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" },
    1,
    ["args: $ref nested deeper than 32 levels"],
  ],
  [
    "a recursive schema over shallow data is fine",
    {
      $defs: { list: { type: ["array", "null"], items: { $ref: "#/$defs/list" } } },
      $ref: "#/$defs/list",
    },
    [[[null]]],
    [],
  ],
];

describe("$ref and $defs", () => checkRows(REF_ROWS));
describe("$ref cycles", () => checkRows(CYCLE_ROWS));
