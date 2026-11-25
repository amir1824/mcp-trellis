import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { apiTool, defineTool, type StandardSchemaV1 } from "../../../src/server.js";

type Ctx = Record<string, never>;

const outputSchema = { type: "array", items: { type: "string" } };
const annotations = { title: "T", readOnlyHint: true };
const accepting: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value: value as Record<string, unknown> }),
  },
};
const base = { name: "t", description: "d", inputSchema: { type: "object" as const } };

describe("outputSchema and annotations through the helpers", () => {
  it("defineTool forwards both, with and without an input validator", () => {
    const raw = defineTool<Ctx>({ ...base, outputSchema, annotations, handler: () => "ok" });
    const typed = defineTool<Ctx, Record<string, unknown>>({
      ...base,
      input: accepting,
      outputSchema,
      annotations,
      handler: () => "ok",
    });
    assert.deepEqual(
      [raw, typed].map((d) => [d.outputSchema, d.annotations]),
      [
        [outputSchema, annotations],
        [outputSchema, annotations],
      ],
    );
  });

  it("apiTool forwards both, with and without an input validator", () => {
    const request = () => new Request("https://example.test/x");
    const raw = apiTool<Ctx>({ ...base, outputSchema, annotations, request });
    const typed = apiTool<Ctx, Record<string, unknown>>({
      ...base,
      input: accepting,
      outputSchema,
      annotations,
      request,
    });
    assert.deepEqual(
      [raw, typed].map((d) => [d.outputSchema, d.annotations]),
      [
        [outputSchema, annotations],
        [outputSchema, annotations],
      ],
    );
  });

  it("leaves both keys off the tool when they are not given", () => {
    const def = defineTool<Ctx>({ ...base, handler: () => "ok" });
    assert.deepEqual(Object.keys(def).sort(), ["description", "handler", "inputSchema", "name"]);
  });
});
