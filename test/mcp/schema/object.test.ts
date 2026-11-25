import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";
import { checkRows, type Row } from "./rows.js";

const PROPERTIES_ROWS: Row[] = [
  [
    "properties validates a present property",
    { properties: { a: { type: "string" } } },
    { a: 1 },
    ["args.a: expected string, got number"],
  ],
  ["properties ignores an absent property", { properties: { a: { type: "string" } } }, {}, []],
  ["required reports a missing key", { required: ["a"] }, {}, ["args.a: required"]],
  [
    "properties with a false subschema forbids the property",
    { properties: { a: false } },
    { a: 1 },
    ["args.a: no value is allowed"],
  ],
  ["object keywords ignore a non-object", { required: ["a"], minProperties: 3 }, "x", []],
];

const ADDITIONAL_ROWS: Row[] = [
  [
    "additionalProperties false rejects an extra key",
    { properties: { a: {} }, additionalProperties: false },
    { a: 1, b: 2 },
    ["args.b: not allowed"],
  ],
  [
    "additionalProperties schema validates extras only",
    { properties: { a: { type: "string" } }, additionalProperties: { type: "number" } },
    { a: "x", b: "y" },
    ["args.b: expected number, got string"],
  ],
  [
    "additionalProperties schema accepts matching extras",
    { additionalProperties: { type: "number" } },
    { b: 2 },
    [],
  ],
  [
    "additionalProperties skips keys matched by patternProperties (suite)",
    { patternProperties: { "^v": {} }, additionalProperties: false },
    { vx: 1 },
    [],
  ],
  [
    "additionalProperties rejects keys matching no pattern",
    { patternProperties: { "^v": {} }, additionalProperties: false },
    { x: 1 },
    ["args.x: not allowed"],
  ],
  [
    "patternProperties validates matching keys",
    { patternProperties: { "^n_": { type: "number" } } },
    { n_a: "x", other: "y" },
    ["args.n_a: expected number, got string"],
  ],
  [
    "patternProperties: a key matching two patterns satisfies both (suite)",
    { patternProperties: { a: { type: "number" }, b: { maximum: 1 } } },
    { ab: 5 },
    ["args.ab: above maximum 1"],
  ],
];

const SIZE_AND_NAME_ROWS: Row[] = [
  [
    "minProperties rejects too few",
    { minProperties: 2 },
    { a: 1 },
    ["args: fewer than 2 properties"],
  ],
  [
    "maxProperties rejects too many",
    { maxProperties: 1 },
    { a: 1, b: 2 },
    ["args: more than 1 properties"],
  ],
  ["maxProperties accepts the limit", { maxProperties: 2 }, { a: 1, b: 2 }, []],
  ["propertyNames accepts valid names", { propertyNames: { maxLength: 3 } }, { abc: 1 }, []],
  [
    "propertyNames rejects an invalid name",
    { propertyNames: { maxLength: 3 } },
    { abcd: 1 },
    ["args.abcd: invalid property name"],
  ],
  [
    "propertyNames false allows only the empty object",
    { propertyNames: false },
    { a: 1 },
    ["args.a: invalid property name"],
  ],
  [
    "propertyNames clips a long name",
    { propertyNames: { maxLength: 3 } },
    { [`${"k".repeat(100)}`]: 1 },
    [`args.${"k".repeat(64)}…: invalid property name`],
  ],
];

const DEPENDENCY_ROWS: Row[] = [
  [
    "dependentRequired accepts when the trigger is absent",
    { dependentRequired: { a: ["b"] } },
    {},
    [],
  ],
  [
    "dependentRequired accepts when satisfied",
    { dependentRequired: { a: ["b"] } },
    { a: 1, b: 2 },
    [],
  ],
  [
    "dependentRequired rejects a missing dependent",
    { dependentRequired: { a: ["b"] } },
    { a: 1 },
    ["args.b: required when a is present"],
  ],
  [
    "dependentSchemas applies when the trigger is present",
    { dependentSchemas: { a: { required: ["b"] } } },
    { a: 1 },
    ["args.b: required"],
  ],
  [
    "dependentSchemas is skipped when the trigger is absent",
    { dependentSchemas: { a: { required: ["b"] } } },
    {},
    [],
  ],
];

describe("properties and required", () => checkRows(PROPERTIES_ROWS));
describe("additionalProperties and patternProperties", () => checkRows(ADDITIONAL_ROWS));
describe("size and names", () => checkRows(SIZE_AND_NAME_ROWS));
describe("dependencies", () => checkRows(DEPENDENCY_ROWS));

describe("a client's property key in messages", () => {
  const schema = { additionalProperties: false } as const;
  const messagesFor = (key: string): string[] => validateAgainstSchema({ [key]: 1 }, schema);

  it("clips a 500 KB key", () => {
    const [message = ""] = messagesFor("k".repeat(500_000));
    assert.ok(message.length < 200, `message was ${message.length} characters`);
  });

  it("replaces newlines and control characters", () => {
    const [message = ""] = messagesFor("a\nb\r\u0000c\u2028d");
    assert.equal(message, "args.a?b??c?d: not allowed");
  });
});
