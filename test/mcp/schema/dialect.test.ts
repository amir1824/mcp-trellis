import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import { unsupportedKeywords } from "../../../src/mcp/schema/check.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { validateAgainstSchema } from "../../../src/mcp/schema/validate.js";

const ACCEPTED_URIS = [
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema",
];

const REJECTED_URIS = [
  "http://json-schema.org/draft-04/schema#",
  "http://json-schema.org/draft-06/schema#",
  "https://json-schema.org/draft-07/schema",
  "https://example.com/my-dialect",
];

/** What zod-to-json-schema emits by default, trimmed to the parts that matter. */
const ZOD_DRAFT_07: JsonSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  required: ["name"],
  additionalProperties: false,
};

const LEGACY_ROWS: Array<[label: string, schema: JsonSchema, expected: string[]]> = [
  [
    "definitions",
    { $schema: "http://json-schema.org/draft-07/schema#", definitions: {} },
    ["args.definitions (draft-07 style keyword; use $defs)"],
  ],
  [
    "dependencies",
    { dependencies: { a: ["b"] } },
    ["args.dependencies (draft-07 style keyword; use dependentRequired or dependentSchemas)"],
  ],
  [
    "array-form items",
    { type: "array", items: [{ type: "string" }] as unknown as JsonSchema },
    ["args.items (draft-07 style keyword; use prefixItems for a tuple)"],
  ],
  [
    "additionalItems",
    { additionalItems: false },
    ["args.additionalItems (draft-07 style keyword; use items after prefixItems)"],
  ],
  [
    "$recursiveRef",
    { $recursiveRef: "#" },
    ["args.$recursiveRef (2019-09 style keyword; use $ref)"],
  ],
  [
    "$recursiveAnchor",
    { $recursiveAnchor: true },
    ["args.$recursiveAnchor (2019-09 style keyword; use $anchor)"],
  ],
];

describe("$schema dialects", () => {
  ACCEPTED_URIS.forEach((uri) => {
    it(`accepts ${uri}`, () => {
      assert.deepEqual(unsupportedKeywords({ $schema: uri }), []);
    });

    it(`accepts ${uri}#`, () => {
      assert.deepEqual(unsupportedKeywords({ $schema: `${uri}#` }), []);
    });
  });

  REJECTED_URIS.forEach((uri) => {
    it(`rejects ${uri} as an unsupported dialect`, () => {
      assert.deepEqual(unsupportedKeywords({ $schema: uri }), [
        "args.$schema (unsupported dialect)",
      ]);
    });
  });

  it("builds a registry from a draft-07 schema and evaluates it as 2020-12", () => {
    const registry = createToolRegistry([
      { name: "t", description: "t", inputSchema: ZOD_DRAFT_07, handler: () => "ok" },
    ]);
    assert.equal(registry.get("t")?.inputSchema.$schema, ZOD_DRAFT_07.$schema);
  });

  it("rejects an argument that breaks a draft-07 schema", () => {
    assert.deepEqual(validateAgainstSchema({ name: "", extra: 1 }, ZOD_DRAFT_07), [
      "args.name: shorter than minLength 1",
      "args.extra: not allowed",
    ]);
  });
});

describe("draft-07 and 2019-09 keywords are rejected, not reinterpreted", () => {
  LEGACY_ROWS.forEach(([label, schema, expected]) => {
    it(label, () => {
      assert.deepEqual(unsupportedKeywords(schema), expected);
    });
  });

  it("accepts the 2020-12 tuple form", () => {
    assert.deepEqual(unsupportedKeywords({ prefixItems: [{ type: "string" }], items: false }), []);
  });
});
