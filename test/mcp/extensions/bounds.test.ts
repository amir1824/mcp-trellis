import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { buildParamHandler, callAnnotated } from "./harness.js";

const MAX_VALUE = 8192;
const MAX_PARAMS = 16;

const b64 = (text: string) => `=?base64?${Buffer.from(text).toString("base64")}?=`;
const long = (length: number) => "a".repeat(length);

describe("Mcp-Param-* value length", () => {
  it("accepts a plain value of exactly the bound", async () => {
    const env = buildParamHandler();
    const response = await callAnnotated(
      env,
      { region: long(MAX_VALUE) },
      { "Mcp-Param-Region": long(MAX_VALUE) },
    );
    assert.equal((await response.json()).result !== undefined, true);
  });

  it("answers a mismatch, never a throw, for a plain value over the bound", async () => {
    const env = buildParamHandler();
    const response = await callAnnotated(
      env,
      { region: long(MAX_VALUE + 1) },
      { "Mcp-Param-Region": long(MAX_VALUE + 1) },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, -32020);
    assert.equal(env.ran.count, 0);
  });

  it("answers a mismatch for an encoded value over the bound", async () => {
    const env = buildParamHandler();
    const value = long(MAX_VALUE);
    const response = await callAnnotated(
      env,
      { region: value },
      { "Mcp-Param-Region": b64(value) },
    );
    assert.equal(response.status, 400);
    assert.equal(env.ran.count, 0);
  });
});

const annotated = (count: number): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `p${index}`,
      { type: "string", "x-mcp-header": `H${index}` },
    ]),
  ),
});
const build = (count: number) => () =>
  createToolRegistry([
    { name: "t", description: "d", inputSchema: annotated(count), handler: () => "" },
  ]);

describe("x-mcp-header count per tool", () => {
  it("accepts the bound", () => {
    assert.doesNotThrow(build(MAX_PARAMS));
  });

  it("rejects one more, naming the tool and the bound", () => {
    assert.throws(
      build(MAX_PARAMS + 1),
      (error: Error) => error.message.includes("t: ") && error.message.includes(String(MAX_PARAMS)),
    );
  });
});
