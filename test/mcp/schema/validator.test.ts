import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../../src/app.js";
import { createToolRegistry, type RegistryOptions } from "../../../src/mcp/registry.js";
import type { JsonSchema, SchemaValidator } from "../../../src/mcp/schema/types.js";
import type { ToolResult } from "../../../src/mcp/tools/content.js";

type Ctx = Record<string, never>;

const UNSUPPORTED: JsonSchema = {
  type: "object",
  properties: { code: { type: "string", pattern: "^(?=a)a+$" } },
  required: ["code"],
};
const OUTPUT_UNSUPPORTED: JsonSchema = {
  type: "object",
  properties: { code: { pattern: "^(?=a)a+$" } },
};
const SECRET = "thrown-secret-detail";
const INVALID_ARGUMENTS = "Invalid arguments";
const INVALID_RESULT = "Tool returned an invalid result";

const text = (result: ToolResult): string =>
  result.content[0]?.type === "text" ? result.content[0].text : "";

/** Ajv-shaped: accepts the pattern the built-in evaluator refuses, reports `code` when it is not "aaa". */
const ajvLike: SchemaValidator = (value) =>
  (value as { code?: string }).code === "aaa" ? [] : ["code must match pattern ^(?=a)a+$"];

/** Accepts every argument and hands only the result check to `validator`. */
const onlyForOutput =
  (validator: SchemaValidator): SchemaValidator =>
  (value, schema) =>
    schema === OUTPUT_UNSUPPORTED ? validator(value, schema) : [];

const build = (options: RegistryOptions, outputSchema?: JsonSchema, result?: ToolResult) => {
  const handled: unknown[] = [];
  const registry = createToolRegistry<Ctx>(
    [
      {
        name: "t",
        description: "d",
        inputSchema: UNSUPPORTED,
        ...(outputSchema ? { outputSchema } : {}),
        handler: (_ctx, args) => {
          handled.push(args);
          return result ?? "ok";
        },
      },
    ],
    options,
  );
  return { registry, handled };
};

const BROKEN_VALIDATORS: Array<[label: string, validator: SchemaValidator]> = [
  [
    "throws",
    () => {
      throw new Error(SECRET);
    },
  ],
  ["returns a promise", (() => Promise.resolve([])) as unknown as SchemaValidator],
  ["returns a string", (() => "valid") as unknown as SchemaValidator],
  ["returns undefined", (() => undefined) as unknown as SchemaValidator],
  ["returns non-string entries", (() => [1]) as unknown as SchemaValidator],
];

describe("schemaValidator for arguments", () => {
  it("lets a pattern the built-in evaluator refuses be registered", () => {
    assert.doesNotThrow(() => build({ schemaValidator: ajvLike }));
  });

  it("without a validator the same schema is still refused at construction", () => {
    assert.throws(
      () => build({}),
      /args\.properties\.code\.pattern[\s\S]*unsupported regex syntax[\s\S]*lookahead/,
    );
  });

  it("passes what the validator accepts to the handler", async () => {
    const { registry, handled } = build({ schemaValidator: ajvLike });
    const result = await registry.call("t", {}, { code: "aaa" });
    assert.deepEqual([result.isError, handled], [false, [{ code: "aaa" }]]);
  });

  it("returns the validator's violations and skips the handler", async () => {
    const { registry, handled } = build({ schemaValidator: ajvLike });
    const result = await registry.call("t", {}, { code: "b" });
    assert.deepEqual(
      [result.isError, text(result), handled],
      [true, "code must match pattern ^(?=a)a+$", []],
    );
  });

  it("hands the validator the argument value and the tool's own schema", async () => {
    const seen: unknown[][] = [];
    const { registry } = build({
      schemaValidator: (value, schema) => {
        seen.push([value, schema]);
        return [];
      },
    });
    await registry.call("t", {}, { code: "x" });
    assert.deepEqual(seen, [[{ code: "x" }, UNSUPPORTED]]);
  });

  it("skips the missing-object-type check too: the schemas are the developer's", () => {
    const loose: JsonSchema = { properties: { a: { unevaluatedProperties: false } } };
    const tool = { name: "t", description: "d", inputSchema: loose, handler: () => "ok" };
    assert.doesNotThrow(() => createToolRegistry([tool], { schemaValidator: () => [] }));
  });

  BROKEN_VALIDATORS.forEach(([label, validator]) => {
    it(`fails closed when the validator ${label}`, async () => {
      const { registry, handled } = build({ schemaValidator: validator });
      const result = await registry.call("t", {}, { code: "aaa" });
      assert.deepEqual([result.isError, text(result), handled], [true, INVALID_ARGUMENTS, []]);
    });
  });

  it("is not consulted when validateArgs is off", async () => {
    const { registry, handled } = build({
      validateArgs: false,
      validateOutput: false,
      schemaValidator: () => ["never"],
    });
    const result = await registry.call("t", {}, { code: "b" });
    assert.deepEqual([result.isError, handled], [false, [{ code: "b" }]]);
  });
});

describe("a validator that returns a rejecting promise", () => {
  it("fails closed and leaves no unhandled rejection", async (t) => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    t.after(() => process.removeListener("unhandledRejection", record));
    const rejecting = (() => Promise.reject(new Error(SECRET))) as unknown as SchemaValidator;
    const { registry } = build({ schemaValidator: rejecting });
    const result = await registry.call("t", {}, { code: "aaa" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual([text(result), unhandled], [INVALID_ARGUMENTS, []]);
  });
});

describe("schemaValidator for results", () => {
  const structured: ToolResult = {
    content: [{ type: "text", text: "fallback" }],
    structuredContent: { code: "aaa" },
  };

  it("accepts an outputSchema the built-in evaluator refuses, and checks the result with it", async () => {
    const { registry } = build({ schemaValidator: () => [] }, OUTPUT_UNSUPPORTED, structured);
    const result = await registry.call("t", {}, { code: "aaa" });
    assert.equal(result.isError, undefined);
  });

  it("replaces a result the validator rejects with the generic error, and reports the violations", async () => {
    const reported: Array<[string, string[]]> = [];
    const { registry } = build(
      {
        schemaValidator: onlyForOutput(() => ["x"]),
        onOutputViolation: (tool, violations) => reported.push([tool, violations]),
      },
      OUTPUT_UNSUPPORTED,
      { ...structured, structuredContent: { code: "other" } },
    );
    const result = await registry.call("t", {}, { code: "aaa" });
    assert.deepEqual([text(result), reported], [INVALID_RESULT, [["t", ["x"]]]]);
  });

  BROKEN_VALIDATORS.forEach(([label, validator]) => {
    it(`fails closed when the validator ${label}`, async () => {
      const reported: string[][] = [];
      const { registry } = build(
        {
          schemaValidator: onlyForOutput(validator),
          onOutputViolation: (_tool, violations) => reported.push(violations),
        },
        OUTPUT_UNSUPPORTED,
        structured,
      );
      const result = await registry.call("t", {}, { code: "aaa" });
      assert.deepEqual([result.isError, text(result)], [true, INVALID_RESULT]);
      assert.equal(JSON.stringify(reported).includes(SECRET), false);
    });
  });
});

describe("schemaValidator through createMcpApp", () => {
  const app = (options: { schemaValidator?: SchemaValidator }) =>
    createMcpApp({
      serverInfo: { name: "t", version: "1" },
      auth: {
        verifyToken: async () => null,
        loginUrl: () => "/login",
        codeSecret: "x".repeat(32),
      } as never,
      allowInMemoryCodeStore: true,
      tools: [{ name: "t", description: "d", inputSchema: UNSUPPORTED, handler: () => "ok" }],
      ...options,
    });

  it("forwards the option to the registry", () => {
    assert.doesNotThrow(() => app({ schemaValidator: ajvLike }));
  });

  it("without it the risky pattern is refused", () => {
    assert.throws(() => app({}), /unsupported regex syntax/);
  });
});
