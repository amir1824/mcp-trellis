import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import { missingObjectType, unsupportedKeywords } from "../../../src/mcp/schema/check.js";
import { MAX_SCHEMA_DEPTH, MAX_SCHEMA_NODES } from "../../../src/mcp/schema/limits.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";

type Row = [label: string, schema: JsonSchema, expected: string[]];

const at = (keywords: JsonSchema): JsonSchema => ({ properties: { a: keywords } });

const HINT = "unsupported regex syntax";
const ESCAPE = "simplify it or pass a schemaValidator";

const REF_ROWS: Row[] = [
  [
    "rejects an https $ref, never fetching it",
    at({ $ref: "https://example.com/s.json" }),
    ["args.properties.a.$ref (non-local $ref)"],
  ],
  [
    "rejects a relative-file $ref",
    at({ $ref: "other.json#/x" }),
    ["args.properties.a.$ref (non-local $ref)"],
  ],
  [
    "rejects a protocol-relative $ref",
    at({ $ref: "//host/x" }),
    ["args.properties.a.$ref (non-local $ref)"],
  ],
  [
    "rejects a file: $ref",
    at({ $ref: "file:///etc/passwd" }),
    ["args.properties.a.$ref (non-local $ref)"],
  ],
  [
    "rejects a loopback $ref",
    at({ $ref: "http://127.0.0.1:8080/s" }),
    ["args.properties.a.$ref (non-local $ref)"],
  ],
  [
    "rejects an unresolved local $ref",
    at({ $ref: "#/$defs/missing" }),
    ["args.properties.a.$ref (unresolved $ref)"],
  ],
  [
    "rejects a $ref through the prototype chain",
    at({ $ref: "#/constructor" }),
    ["args.properties.a.$ref (unresolved $ref)"],
  ],
  [
    "rejects a $ref into non-schema data",
    { default: { x: 1 }, ...at({ $ref: "#/default" }) },
    ["args.properties.a.$ref (unresolved $ref)"],
  ],
  [
    "rejects an unknown $anchor",
    at({ $ref: "#nope" }),
    ["args.properties.a.$ref (unresolved $ref)"],
  ],
  [
    "rejects a malformed percent escape",
    at({ $ref: "#/%E0%A4%A" }),
    ["args.properties.a.$ref (unresolved $ref)"],
  ],
  [
    "accepts local pointers and anchors",
    {
      $defs: { d: { $anchor: "d" } },
      properties: { a: { $ref: "#/$defs/d" }, b: { $ref: "#d" }, c: { $ref: "#" } },
    },
    [],
  ],
  [
    "rejects a duplicate $anchor",
    { $defs: { a: { $anchor: "x" }, b: { $anchor: "x" } } },
    ["args.$defs.b.$anchor (duplicate $anchor)"],
  ],
  [
    "rejects an embedded $id that would rebase refs",
    at({ $id: "https://example.com/a" }),
    ["args.properties.a.$id (embedded schema resources are not supported)"],
  ],
  ["accepts a root $id", { $id: "https://example.com/root" }, []],
];

const DIALECT_ROWS: Row[] = [
  ["accepts an absent $schema", {}, []],
  ["accepts the 2020-12 URI", { $schema: "https://json-schema.org/draft/2020-12/schema" }, []],
  [
    "accepts the 2020-12 URI with an empty fragment",
    { $schema: "https://json-schema.org/draft/2020-12/schema#" },
    [],
  ],
  [
    "rejects draft-04",
    { $schema: "http://json-schema.org/draft-04/schema#" },
    ["args.$schema (unsupported dialect)"],
  ],
  [
    "rejects a non-string $schema",
    { $schema: 7 as unknown as string },
    ["args.$schema (unsupported dialect)"],
  ],
];

const KEYWORD_ROWS: Row[] = [
  ["accepts x-mcp-header as an annotation", at({ type: "string", "x-mcp-header": "Region" }), []],
  ["accepts any x-* keyword", at({ "x-anything": { nested: true } }), []],
  [
    "accepts format and content* as annotations",
    at({ format: "email", contentEncoding: "base64" }),
    [],
  ],
  ["rejects an unknown keyword", at({ frobnicate: 1 }), ["args.properties.a.frobnicate"]],
  [
    "rejects definitions (draft-07 spelling; use $defs)",
    { definitions: {} },
    ["args.definitions (draft-07 style keyword; use $defs)"],
  ],
  [
    "rejects unevaluatedProperties (not implemented)",
    { unevaluatedProperties: false },
    ["args.unevaluatedProperties"],
  ],
  ["rejects $dynamicRef (not implemented)", { $dynamicRef: "#x" }, ["args.$dynamicRef"]],
  ["rejects a prototype-named keyword", JSON.parse('{"__proto__": {}}'), ["args.__proto__"]],
  [
    "rejects an invalid pattern",
    at({ pattern: "(" }),
    [`args.properties.a.pattern (${HINT} for pattern: unterminated group; ${ESCAPE})`],
  ],
  [
    "rejects an invalid patternProperties key",
    { patternProperties: { "[a-": {} } },
    [
      `args.patternProperties (${HINT} for patternProperties "[a-": unterminated character class; ${ESCAPE})`,
    ],
  ],
  [
    "rejects a pattern only valid without the u flag",
    at({ pattern: "\\-" }),
    [`args.properties.a.pattern (${HINT} for pattern: invalid escape \\-; ${ESCAPE})`],
  ],
  [
    "rejects an unknown type name",
    at({ type: "strng" }),
    ["args.properties.a.type (invalid value)"],
  ],
  [
    "rejects required that is not a list",
    at({ required: "a" as unknown as string[] }),
    ["args.properties.a.required (invalid value)"],
  ],
  [
    "rejects a negative minLength",
    at({ minLength: -1 }),
    ["args.properties.a.minLength (invalid value)"],
  ],
  ["rejects multipleOf 0", at({ multipleOf: 0 }), ["args.properties.a.multipleOf (invalid value)"]],
  [
    "rejects the draft-07 tuple form of items",
    at({ items: [{}] as unknown as JsonSchema }),
    ["args.properties.a.items (draft-07 style keyword; use prefixItems for a tuple)"],
  ],
  ["rejects an empty anyOf", at({ anyOf: [] }), ["args.properties.a.anyOf (invalid value)"]],
  [
    "reports nested keywords inside composition and $defs",
    { allOf: [{ foo: 1 }], $defs: { d: { bar: 1 } } },
    ["args.allOf.0.foo", "args.$defs.d.bar"],
  ],
];

const nested = (levels: number): JsonSchema =>
  Array.from({ length: levels }).reduce<JsonSchema>((inner) => ({ not: inner }), {});

const BOUND_ROWS: Row[] = [
  ["accepts nesting at the depth bound", nested(MAX_SCHEMA_DEPTH), []],
  [
    "rejects nesting over the depth bound",
    nested(MAX_SCHEMA_DEPTH + 1),
    [
      `${Array.from({ length: MAX_SCHEMA_DEPTH + 1 }, () => "not").reduce((p, s) => `${p}.${s}`, "args")} (schema nested deeper than ${MAX_SCHEMA_DEPTH} levels)`,
    ],
  ],
  [
    "rejects a schema over the subschema bound",
    {
      properties: Object.fromEntries(
        Array.from({ length: MAX_SCHEMA_NODES + 1 }, (_, i) => [`p${i}`, {}]),
      ),
    },
    [
      `args.properties.p${MAX_SCHEMA_NODES - 1} (schema has more than ${MAX_SCHEMA_NODES} subschemas)`,
    ],
  ],
];

const SCHEMA_ROWS: Row[] = [...REF_ROWS, ...DIALECT_ROWS, ...KEYWORD_ROWS, ...BOUND_ROWS];

describe("unsupportedKeywords: construction-time rejection", () => {
  SCHEMA_ROWS.forEach(([label, schema, expected]) => {
    it(label, () => {
      assert.deepEqual(unsupportedKeywords(schema), expected);
    });
  });
});

const tool = (inputSchema: JsonSchema) => ({
  name: "t",
  description: "t",
  inputSchema,
  handler: () => "ok",
});

describe("createToolRegistry with validateArgs", () => {
  it("throws on a remote $ref", () => {
    assert.throws(
      () => createToolRegistry([tool(at({ $ref: "https://example.com/s.json" }))]),
      /unsupported JSON Schema keyword at args\.properties\.a\.\$ref \(non-local \$ref\)/,
    );
  });

  it("throws on an unsupported dialect", () => {
    assert.throws(
      () => createToolRegistry([tool({ $schema: "http://json-schema.org/draft-04/schema#" })]),
      /args\.\$schema \(unsupported dialect\)/,
    );
  });

  it("accepts x-mcp-header and a local $ref", () => {
    assert.doesNotThrow(() =>
      createToolRegistry([
        tool({
          type: "object",
          $defs: { region: { type: "string" } },
          properties: {
            region: { $ref: "#/$defs/region" },
            zone: { type: "string", "x-mcp-header": "Zone" },
          },
        }),
      ]),
    );
  });
});

describe("missingObjectType only inspects properties and items", () => {
  const IDIOMS: Array<[string, JsonSchema]> = [
    [
      "required inside anyOf",
      { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] },
    ],
    ["properties inside if", { type: "object", if: { properties: { a: { const: 1 } } } }],
    ["properties inside $defs", { type: "object", $defs: { d: { properties: { a: {} } } } }],
    [
      "required inside dependentSchemas",
      { type: "object", dependentSchemas: { a: { required: ["b"] } } },
    ],
  ];

  IDIOMS.forEach(([label, schema]) => {
    it(`does not flag ${label}`, () => {
      assert.deepEqual(missingObjectType(schema), []);
    });
  });

  it("still flags a type-less nested property", () => {
    const schema: JsonSchema = { type: "object", properties: { a: { required: ["b"] } } };
    assert.deepEqual(missingObjectType(schema), ["args.properties.a"]);
  });
});
