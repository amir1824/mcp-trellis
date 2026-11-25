import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry, type ToolDef } from "../../../src/mcp/registry.js";
import type { ToolAnnotations } from "../../../src/server.js";
import { MODERN_VERSION, requestAs } from "./harness.js";

type Ctx = Record<string, never>;

const withAnnotations = (annotations: unknown): ToolDef<Ctx> => ({
  name: "t",
  description: "d",
  inputSchema: { type: "object" },
  annotations: annotations as ToolAnnotations,
  handler: () => "ok",
});

const ALL_FIVE: ToolAnnotations = {
  title: "T",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRONG: Array<[string, unknown, RegExp]> = [
  ["title as a number", { title: 1 }, /t: annotations\.title must be a string, got number/],
  [
    "readOnlyHint as a string",
    { readOnlyHint: "yes" },
    /annotations\.readOnlyHint must be a boolean/,
  ],
  [
    "destructiveHint as a number",
    { destructiveHint: 0 },
    /annotations\.destructiveHint must be a boolean/,
  ],
  [
    "idempotentHint as null",
    { idempotentHint: null },
    /annotations\.idempotentHint must be a boolean/,
  ],
  [
    "openWorldHint as an object",
    { openWorldHint: {} },
    /annotations\.openWorldHint must be a boolean/,
  ],
  ["an unknown field", { readOnly: true }, /annotations\.readOnly is not an MCP tool annotation/],
  ["a non-object value", "hint", /t: annotations must be an object/],
];

describe("tool annotations", () => {
  it("lists all five fields in tools/list", async () => {
    const reply = await requestAs(MODERN_VERSION, [withAnnotations(ALL_FIVE)], "tools/list");
    assert.deepEqual(reply.result.tools?.[0]?.annotations, ALL_FIVE);
  });

  it("omits annotations from the listing when none are set", () => {
    const listed = createToolRegistry<Ctx>([
      { ...withAnnotations(ALL_FIVE), annotations: undefined },
    ]).list();
    assert.equal("annotations" in (listed[0] ?? {}), false);
  });

  WRONG.forEach(([label, annotations, message]) => {
    it(`throws at construction naming the tool for ${label}`, () => {
      assert.throws(() => createToolRegistry<Ctx>([withAnnotations(annotations)]), message);
    });
  });

  it("checks annotations even when validateArgs is false", () => {
    assert.throws(
      () => createToolRegistry<Ctx>([withAnnotations({ title: 1 })], { validateArgs: false }),
      /annotations\.title/,
    );
  });

  it("does not use a readOnlyHint to authorize anything: the call still runs", async () => {
    const registry = createToolRegistry<Ctx>([withAnnotations({ readOnlyHint: true })]);
    assert.equal((await registry.call("t", {}, {})).isError, false);
  });
});
