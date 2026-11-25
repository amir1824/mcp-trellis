import { describe } from "node:test";
import { checkRows, type Row } from "./rows.js";

const ITEMS_ROWS: Row[] = [
  [
    "items validates each element with its index in the path",
    { items: { type: "string" } },
    ["a", 1],
    ["args[1]: expected string, got number"],
  ],
  [
    "items false allows only the empty array",
    { items: false },
    [1],
    ["args[0]: no value is allowed"],
  ],
  [
    "prefixItems validates by position",
    { prefixItems: [{ type: "string" }, { type: "number" }] },
    ["a", "b"],
    ["args[1]: expected number, got string"],
  ],
  [
    "prefixItems allows a shorter array (suite)",
    { prefixItems: [{ type: "string" }, { type: "number" }] },
    ["a"],
    [],
  ],
  [
    "items applies only after prefixItems (suite)",
    { prefixItems: [{ type: "string" }], items: { type: "number" } },
    ["a", 1, "b"],
    ["args[2]: expected number, got string"],
  ],
  ["array keywords ignore a non-array", { items: { type: "string" }, minItems: 3 }, "x", []],
];

const SIZE_ROWS: Row[] = [
  ["minItems rejects too few", { minItems: 2 }, [1], ["args: fewer than 2 items"]],
  ["maxItems rejects too many", { maxItems: 1 }, [1, 2], ["args: more than 1 items"]],
  ["maxItems accepts the limit", { maxItems: 2 }, [1, 2], []],
];

const CONTAINS_ROWS: Row[] = [
  ["contains accepts one match", { contains: { type: "number" } }, ["a", 1], []],
  [
    "contains rejects no match",
    { contains: { type: "number" } },
    ["a"],
    ["args: fewer than 1 items match contains"],
  ],
  [
    "contains rejects an empty array (suite)",
    { contains: {} },
    [],
    ["args: fewer than 1 items match contains"],
  ],
  [
    "minContains 0 accepts no match (suite)",
    { contains: { type: "number" }, minContains: 0 },
    ["a"],
    [],
  ],
  [
    "minContains 2 rejects one match",
    { contains: { type: "number" }, minContains: 2 },
    [1, "a"],
    ["args: fewer than 2 items match contains"],
  ],
  [
    "maxContains rejects too many matches",
    { contains: { type: "number" }, maxContains: 1 },
    [1, 2],
    ["args: more than 1 items match contains"],
  ],
  [
    "maxContains accepts the limit",
    { contains: { type: "number" }, maxContains: 2 },
    [1, 2, "a"],
    [],
  ],
];

const UNIQUE_ROWS: Row[] = [
  ["uniqueItems accepts distinct values", { uniqueItems: true }, [1, 2, "1"], []],
  [
    "uniqueItems rejects equal numbers (1 and 1.0)",
    { uniqueItems: true },
    [1, 1.0],
    ["args: items are not unique"],
  ],
  ["uniqueItems treats 1 and true as distinct (suite)", { uniqueItems: true }, [1, true], []],
  [
    "uniqueItems ignores object key order (suite)",
    { uniqueItems: true },
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
    ["args: items are not unique"],
  ],
  [
    "uniqueItems compares nested arrays",
    { uniqueItems: true },
    [
      [1, [2]],
      [1, [2]],
    ],
    ["args: items are not unique"],
  ],
  ["uniqueItems false allows duplicates", { uniqueItems: false }, [1, 1], []],
];

describe("items and prefixItems", () => checkRows(ITEMS_ROWS));
describe("minItems and maxItems", () => checkRows(SIZE_ROWS));
describe("contains", () => checkRows(CONTAINS_ROWS));
describe("uniqueItems", () => checkRows(UNIQUE_ROWS));
