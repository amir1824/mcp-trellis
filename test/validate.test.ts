import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../src/registry.js";
import {
  unsupportedKeywords,
  validateAgainstSchema,
} from "../src/validate.js";

describe("schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      count: { type: "integer" },
      status: { type: "string", enum: ["open", "closed"] },
      flag: { type: "boolean" },
      nothing: { type: "null" },
      tags: { type: "array", items: { type: "string" } },
      nested: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
    required: ["query"],
  };

  it("accepts valid args", () => {
    assert.deepEqual(
      validateAgainstSchema(
        { query: "hi", limit: 10, status: "open" },
        schema,
      ),
      [],
    );
  });

  it("rejects missing required", () => {
    const errors = validateAgainstSchema({}, schema);
    assert.ok(errors.some((e) => /required/.test(e)));
  });

  it("rejects wrong type", () => {
    const errors = validateAgainstSchema({ query: 1 }, schema);
    assert.ok(errors.some((e) => /expected string/.test(e)));
  });

  it("rejects enum and bounds", () => {
    const enumErrors = validateAgainstSchema(
      { query: "x", status: "nope" },
      schema,
    );
    assert.ok(enumErrors.some((e) => /enum/.test(e)));
    const boundErrors = validateAgainstSchema(
      { query: "x", limit: 0 },
      schema,
    );
    assert.ok(boundErrors.some((e) => /minimum/.test(e)));
    const maxErrors = validateAgainstSchema(
      { query: "x", limit: 101 },
      schema,
    );
    assert.ok(maxErrors.some((e) => /maximum/.test(e)));
  });

  it("collects multiple errors", () => {
    const errors = validateAgainstSchema(
      { query: 1, limit: 0, status: "nope" },
      schema,
    );
    assert.ok(errors.length >= 2);
  });

  it("accepts integer and rejects float", () => {
    assert.deepEqual(
      validateAgainstSchema({ query: "x", count: 3 }, schema),
      [],
    );
    const errors = validateAgainstSchema({ query: "x", count: 1.5 }, schema);
    assert.ok(errors.some((e) => /expected integer/.test(e)));
  });

  it("validates boolean, null, array items, and nested objects", () => {
    assert.deepEqual(
      validateAgainstSchema(
        {
          query: "x",
          flag: true,
          nothing: null,
          tags: ["a", "b"],
          nested: { city: "TLV" },
        },
        schema,
      ),
      [],
    );
    assert.ok(
      validateAgainstSchema({ query: "x", flag: "yes" }, schema).some((e) =>
        /boolean/.test(e),
      ),
    );
    assert.ok(
      validateAgainstSchema({ query: "x", tags: [1] }, schema).some((e) =>
        /expected string/.test(e),
      ),
    );
    assert.ok(
      validateAgainstSchema({ query: "x", nested: {} }, schema).some((e) =>
        /required/.test(e),
      ),
    );
  });
});

describe("unsupportedKeywords / validateArgs construction", () => {
  const withPattern = {
    type: "object",
    properties: {
      code: { type: "string", pattern: "^[A-Z]{3}$" },
    },
  };

  it("lists pattern as unsupported", () => {
    assert.deepEqual(unsupportedKeywords(withPattern), [
      "args.properties.code.pattern",
    ]);
  });

  it("lists nested items violations", () => {
    assert.deepEqual(
      unsupportedKeywords({
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: { type: "string", maxLength: 10 },
          },
        },
      }),
      ["args.properties.rows.items.maxLength"],
    );
  });

  it("allows description/title metadata and supported schemas", () => {
    assert.deepEqual(
      unsupportedKeywords({
        type: "object",
        title: "Echo",
        description: "Echo text",
        properties: { text: { type: "string", description: "body" } },
        required: ["text"],
      }),
      [],
    );
  });

  it("allows generator metadata ($schema, $id, $comment, format, …)", () => {
    assert.deepEqual(
      unsupportedKeywords({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://example.test/schemas/city.json",
        $comment: "generator noise",
        type: "object",
        default: {},
        examples: [{}],
        deprecated: false,
        readOnly: false,
        writeOnly: false,
        properties: {
          city: {
            type: "string",
            format: "email",
            default: "TLV",
            examples: ["TLV"],
          },
        },
      }),
      [],
    );
  });

  it("lists additionalProperties as unsupported", () => {
    assert.deepEqual(
      unsupportedKeywords({
        type: "object",
        additionalProperties: false,
        properties: {},
      }),
      ["args.additionalProperties"],
    );
  });

  it("throws at createToolRegistry when validateArgs sees pattern", () => {
    assert.throws(
      () =>
        createToolRegistry(
          [
            {
              name: "coded",
              description: "x",
              inputSchema: withPattern,
              handler: () => "ok",
            },
          ],
          { validateArgs: true },
        ),
      /unsupported JSON Schema keyword.*pattern/,
    );
  });

  it("accepts the same pattern schema when validateArgs is off", () => {
    assert.doesNotThrow(() =>
      createToolRegistry([
        {
          name: "coded",
          description: "x",
          inputSchema: withPattern,
          handler: () => "ok",
        },
      ]),
    );
  });
});
