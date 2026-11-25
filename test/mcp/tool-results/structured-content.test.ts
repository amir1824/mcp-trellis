import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDef } from "../../../src/mcp/registry.js";
import { isToolResult } from "../../../src/mcp/tools/content.js";
import { LEGACY_VERSIONS, MODERN_VERSION, requestAs } from "./harness.js";

type Ctx = Record<string, never>;

const returning = (name: string, structuredContent: unknown): ToolDef<Ctx> => ({
  name,
  description: "d",
  inputSchema: { type: "object" },
  handler: () => ({ content: [{ type: "text", text: "fallback" }], structuredContent }),
});

const NON_OBJECT_VALUES: Array<[string, unknown]> = [
  ["a string", "x"],
  ["a number", 0],
  ["false", false],
  ["null", null],
  ["an array", [1, 2]],
];

describe("isToolResult and structuredContent", () => {
  NON_OBJECT_VALUES.forEach(([label, value]) => {
    it(`accepts ${label} as structuredContent`, () => {
      assert.equal(isToolResult({ content: [], structuredContent: value }), true);
    });
  });

  it("still rejects a _meta that is not an object and a content that is not an array", () => {
    assert.equal(isToolResult({ content: [], _meta: "x" }), false);
    assert.equal(isToolResult({ content: "text" }), false);
  });
});

describe("a non-object structuredContent per protocol version", () => {
  NON_OBJECT_VALUES.forEach(([label, value]) => {
    it(`a 2026-07-28 client receives ${label} unchanged`, async () => {
      const reply = await requestAs(MODERN_VERSION, [returning("t", value)], "tools/call", {
        name: "t",
      });
      assert.deepEqual(reply.result.structuredContent, value);
      assert.equal(reply.result.isError, undefined);
    });

    LEGACY_VERSIONS.forEach((version) => {
      it(`a ${version} client gets ${label} left out and keeps the text fallback`, async () => {
        const reply = await requestAs(version, [returning("t", value)], "tools/call", {
          name: "t",
        });
        assert.equal("structuredContent" in reply.result, false);
        assert.equal(reply.result.content?.[0]?.text, "fallback");
        assert.equal(reply.result.isError, undefined);
      });
    });
  });

  LEGACY_VERSIONS.forEach((version) => {
    it(`a ${version} client still receives an object structuredContent`, async () => {
      const reply = await requestAs(version, [returning("t", { a: 1 })], "tools/call", {
        name: "t",
      });
      assert.deepEqual(reply.result.structuredContent, { a: 1 });
    });
  });
});
