import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateAgainstSchema } from "../src/validate.js";

describe("schema validation", () => {
  const schema = {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", minimum: 1, maximum: 100 },
      count: { type: "integer" },
      status: { type: "string", enum: ["open", "closed"] },
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
});
