import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry, type ToolDef } from "../../../src/mcp/registry.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import type { ToolResult } from "../../../src/mcp/tools/content.js";
import { LEGACY_VERSIONS, MODERN_VERSION, requestAs } from "./harness.js";

type Ctx = Record<string, never>;

const ARRAY_SCHEMA: JsonSchema = { type: "array", items: { type: "string" } };
const OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: { total: { type: "number" } },
  required: ["total"],
};
const SECRET = "tenant-globex-secret";
const GENERIC_ERROR = "Tool returned an invalid result";

const tool = (outputSchema: JsonSchema | undefined, result: ToolResult): ToolDef<Ctx> => ({
  name: "t",
  description: "d",
  inputSchema: { type: "object" },
  ...(outputSchema ? { outputSchema } : {}),
  handler: () => result,
});

const text = [{ type: "text" as const, text: "fallback" }];
const call = (def: ToolDef<Ctx>, options = {}) =>
  createToolRegistry<Ctx>([def], options).call("t", {}, {});

describe("outputSchema listing", () => {
  it("is listed with a non-object root for a 2026-07-28 client", async () => {
    const reply = await requestAs(
      MODERN_VERSION,
      [tool(ARRAY_SCHEMA, { content: text })],
      "tools/list",
    );
    assert.deepEqual(reply.result.tools?.[0]?.outputSchema, ARRAY_SCHEMA);
  });

  it("is left out of a legacy listing when its root is not an object", async () => {
    const reply = await requestAs(
      LEGACY_VERSIONS[2],
      [tool(ARRAY_SCHEMA, { content: text })],
      "tools/list",
    );
    assert.equal("outputSchema" in (reply.result.tools?.[0] ?? {}), false);
  });

  it("is kept in a legacy listing when its root is an object", async () => {
    const reply = await requestAs(
      LEGACY_VERSIONS[2],
      [tool(OBJECT_SCHEMA, { content: text })],
      "tools/list",
    );
    assert.deepEqual(reply.result.tools?.[0]?.outputSchema, OBJECT_SCHEMA);
  });

  it("is absent from the listing when the tool declares none", () => {
    const listed = createToolRegistry<Ctx>([tool(undefined, { content: text })]).list();
    assert.equal("outputSchema" in (listed[0] ?? {}), false);
  });
});

describe("outputSchema construction check", () => {
  it("throws naming the tool and outputSchema for an unsupported keyword", () => {
    assert.throws(
      () => createToolRegistry<Ctx>([tool({ type: "object", oneOf: [] }, { content: text })]),
      /t: unsupported JSON Schema keyword at outputSchema/,
    );
  });

  it("throws naming the tool for an outputSchema that is not an object", () => {
    assert.throws(
      () => createToolRegistry<Ctx>([tool("string" as never, { content: text })]),
      /t: outputSchema must be a JSON Schema object/,
    );
  });

  it("does not check the outputSchema when validateOutput is off", () => {
    const def = tool({ type: "object", oneOf: [] }, { content: text });
    assert.doesNotThrow(() => createToolRegistry<Ctx>([def], { validateOutput: false }));
  });
});

describe("outputSchema result validation", () => {
  it("returns a conforming result unchanged", async () => {
    const result = { content: text, structuredContent: { total: 3 } };
    assert.deepEqual(await call(tool(OBJECT_SCHEMA, result)), result);
  });

  it("accepts a non-object structuredContent that matches a non-object root", async () => {
    const result = { content: text, structuredContent: ["a"] };
    assert.deepEqual(await call(tool(ARRAY_SCHEMA, result)), result);
  });

  it("replaces a violating result with the generic error and never echoes the data", async () => {
    const reply = await call(
      tool(OBJECT_SCHEMA, { content: text, structuredContent: { total: SECRET } }),
    );
    assert.deepEqual(reply, { content: [{ type: "text", text: GENERIC_ERROR }], isError: true });
  });

  it("replaces a result with no structuredContent by the generic error", async () => {
    const reply = await call(tool(OBJECT_SCHEMA, { content: text }));
    assert.equal(reply.isError, true);
    assert.equal(reply.content[0]?.text, GENERIC_ERROR);
  });

  it("skips validation of an isError result", async () => {
    const failed = { content: text, isError: true };
    assert.deepEqual(await call(tool(OBJECT_SCHEMA, failed)), failed);
  });

  it("skips validation when validateOutput is false", async () => {
    const result = { content: text, structuredContent: { total: SECRET } };
    assert.deepEqual(await call(tool(OBJECT_SCHEMA, result), { validateOutput: false }), result);
  });

  it("follows validateArgs when validateOutput is not set", async () => {
    const result = { content: text, structuredContent: { total: SECRET } };
    assert.deepEqual(await call(tool(OBJECT_SCHEMA, result), { validateArgs: false }), result);
  });
});

describe("onOutputViolation", () => {
  const violating = tool(OBJECT_SCHEMA, { content: text, structuredContent: { total: SECRET } });

  it("receives the tool name and the violations, rooted at structuredContent", async () => {
    const seen: Array<[string, string[]]> = [];
    await call(violating, {
      onOutputViolation: (name: string, v: string[]) => seen.push([name, v]),
    });
    assert.equal(seen[0]?.[0], "t");
    assert.match(seen[0]?.[1][0] ?? "", /^structuredContent\.total/);
  });

  it("reports a missing structuredContent", async () => {
    const seen: string[][] = [];
    await call(tool(OBJECT_SCHEMA, { content: text }), {
      onOutputViolation: (_name: string, v: string[]) => seen.push(v),
    });
    assert.deepEqual(seen, [["structuredContent is missing"]]);
  });

  it("a throwing hook does not fail the call", async () => {
    const reply = await call(violating, {
      onOutputViolation: () => {
        throw new Error("hook down");
      },
    });
    assert.equal(reply.content[0]?.text, GENERIC_ERROR);
  });

  it("a hook returning a rejected promise does not fail the call", async () => {
    const reply = await call(violating, {
      onOutputViolation: () => Promise.reject(new Error("hook down")),
    });
    assert.equal(reply.content[0]?.text, GENERIC_ERROR);
  });
});
