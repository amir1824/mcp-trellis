import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unsupportedKeywords } from "../../../src/mcp/schema/check.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";

type Row = [label: string, schema: JsonSchema, instanceJson: string, expected: string[]];

/** Instances come from `JSON.parse`, the way client input does: `__proto__` becomes an own key. */
const ROWS: Row[] = [
  [
    "required names a prototype member that is not an own key",
    { required: ["toString", "__proto__"] },
    "{}",
    ["args.toString: required", "args.__proto__: required"],
  ],
  ["required is met by an own __proto__ key", { required: ["__proto__"] }, '{"__proto__": 1}', []],
  [
    "properties named like prototype members are not applied to {}",
    { properties: { constructor: { type: "string" }, __proto__: { type: "string" } } },
    "{}",
    [],
  ],
  [
    "an own constructor key is validated",
    { properties: { constructor: { type: "string" } } },
    '{"constructor": 5}',
    ["args.constructor: expected string, got number"],
  ],
  [
    "an own __proto__ key is validated, not skipped",
    JSON.parse('{"properties": {"__proto__": {"type": "string"}}}'),
    '{"__proto__": 5}',
    ["args.__proto__: expected string, got number"],
  ],
  [
    "additionalProperties:false rejects an own __proto__ key",
    { properties: {}, additionalProperties: false },
    '{"__proto__": 1}',
    ["args.__proto__: not allowed"],
  ],
  [
    "patternProperties matches an own __proto__ key",
    { patternProperties: { "^__": { type: "string" } } },
    '{"__proto__": 1}',
    ["args.__proto__: expected string, got number"],
  ],
  [
    "dependentRequired ignores an inherited trigger",
    { dependentRequired: { toString: ["a"] } },
    "{}",
    [],
  ],
  [
    "dependentSchemas ignores an inherited trigger",
    { dependentSchemas: { constructor: false } },
    "{}",
    [],
  ],
  [
    "a deep __proto__ value is just data",
    { properties: { a: { type: "object" } } },
    '{"a": {"__proto__": {"polluted": true}}}',
    [],
  ],
];

describe("prototype-named keys are never read through the prototype chain", () => {
  ROWS.forEach(([label, schema, instanceJson, expected]) => {
    it(label, () => {
      assert.deepEqual(validateAgainstSchema(JSON.parse(instanceJson), schema), expected);
    });
  });

  it("leaves Object.prototype untouched", () => {
    validateAgainstSchema(JSON.parse('{"__proto__": {"polluted": true}}'), { type: "object" });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  it("resolves $ref to an own __proto__ definition but not to an inherited one", () => {
    const own = JSON.parse(
      '{"$defs": {"__proto__": {"type": "string"}}, "$ref": "#/$defs/__proto__"}',
    );
    const inherited: JsonSchema = { $ref: "#/$defs/__proto__" };
    assert.deepEqual(unsupportedKeywords(own), []);
    assert.deepEqual(unsupportedKeywords(inherited), ["args.$ref (unresolved $ref)"]);
  });
});
