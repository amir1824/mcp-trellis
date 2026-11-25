import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { buildParamHandler, callAnnotated, legacyCall, send } from "./harness.js";

const tool = (inputSchema: JsonSchema) => () =>
  createToolRegistry([{ name: "t", description: "d", inputSchema, handler: () => "ok" }]);
const obj = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});

type Violation = { rule: string; build: () => unknown; fragment: string };
const VIOLATIONS: Violation[] = [
  {
    rule: "empty",
    build: tool(obj({ a: { type: "string", "x-mcp-header": "" } })),
    fragment: "a:",
  },
  {
    rule: "space in name",
    build: tool(obj({ a: { type: "string", "x-mcp-header": "A B" } })),
    fragment: "a:",
  },
  {
    rule: "CR/LF in name",
    build: tool(obj({ a: { type: "string", "x-mcp-header": "A\r\nB" } })),
    fragment: "a:",
  },
  {
    rule: "colon in name",
    build: tool(obj({ a: { type: "string", "x-mcp-header": "A:B" } })),
    fragment: "a:",
  },
  {
    rule: "non-string value",
    build: tool(obj({ a: { type: "string", "x-mcp-header": 5 } })),
    fragment: "a:",
  },
  {
    rule: "case-insensitive duplicate",
    build: tool(
      obj({
        a: { type: "string", "x-mcp-header": "Id" },
        b: { type: "string", "x-mcp-header": "iD" },
      }),
    ),
    fragment: "b: x-mcp-header repeats",
  },
  {
    rule: "number type",
    build: tool(obj({ a: { type: "number", "x-mcp-header": "N" } })),
    fragment: "requires type",
  },
  {
    rule: "object type",
    build: tool(obj({ a: { type: "object", "x-mcp-header": "N" } })),
    fragment: "requires type",
  },
  { rule: "no type", build: tool(obj({ a: { "x-mcp-header": "N" } })), fragment: "requires type" },
  {
    rule: "inside items",
    build: tool(obj({ l: { type: "array", items: { type: "string", "x-mcp-header": "I" } } })),
    fragment: "only allowed on a property reached through",
  },
  {
    rule: "inside anyOf",
    build: tool({
      type: "object",
      anyOf: [{ properties: { a: { type: "string", "x-mcp-header": "A" } } }],
    }),
    fragment: "only allowed on a property reached through",
  },
  {
    rule: "behind a nested non-properties keyword",
    build: tool(
      obj({ o: { type: "object", additionalProperties: { type: "string", "x-mcp-header": "A" } } }),
    ),
    fragment: "only allowed on a property reached through",
  },
  {
    rule: "on the schema root",
    build: tool({ type: "object", "x-mcp-header": "R" }),
    fragment: "(schema root)",
  },
];

describe("x-mcp-header at construction", () => {
  VIOLATIONS.forEach(({ rule, build, fragment }) => {
    it(`rejects ${rule}, naming the tool and path`, () => {
      assert.throws(
        build,
        (error: Error) => error.message.includes("t: ") && error.message.includes(fragment),
      );
    });
  });

  it("accepts string, integer, boolean, nullable and nested properties", () => {
    assert.doesNotThrow(
      tool(
        obj({
          a: { type: "string", "x-mcp-header": "A" },
          b: { type: "integer", "x-mcp-header": "B" },
          c: { type: "boolean", "x-mcp-header": "C" },
          d: { type: ["string", "null"], "x-mcp-header": "D" },
          e: obj({ f: { type: "string", "x-mcp-header": "F" } }),
        }),
      ),
    );
  });

  it("ignores the key inside enum/const data", () => {
    assert.doesNotThrow(
      tool(obj({ a: { type: "string", enum: ["x"], const: { "x-mcp-header": 1 } } })),
    );
  });
});

const ok = async (response: Response) => (await response.json()).result !== undefined;
const b64 = (text: string) => `=?base64?${Buffer.from(text).toString("base64")}?=`;

type Row = { name: string; args: Record<string, unknown>; headers: Record<string, string> };
const ACCEPTED: Row[] = [
  { name: "no annotated args, no headers", args: {}, headers: {} },
  {
    name: "matching string",
    args: { region: "us-west1" },
    headers: { "Mcp-Param-Region": "us-west1" },
  },
  {
    name: "header name case-insensitive",
    args: { region: "x" },
    headers: { "mcp-param-region": "x" },
  },
  {
    name: "base64 non-ASCII",
    args: { region: "Hello, 世界" },
    headers: { "Mcp-Param-Region": b64("Hello, 世界") },
  },
  { name: "base64 padded", args: { region: " p " }, headers: { "Mcp-Param-Region": b64(" p ") } },
  {
    name: "base64 sentinel literal",
    args: { region: "=?base64?x?=" },
    headers: { "Mcp-Param-Region": b64("=?base64?x?=") },
  },
  { name: "integer", args: { count: 42 }, headers: { "Mcp-Param-Count": "42" } },
  {
    name: "integer compared numerically",
    args: { count: 42 },
    headers: { "Mcp-Param-Count": "42.0" },
  },
  { name: "boolean", args: { flag: false }, headers: { "Mcp-Param-Flag": "false" } },
  { name: "nested path", args: { nested: { zone: "z" } }, headers: { "Mcp-Param-Zone": "z" } },
  {
    name: "header for an unannotated param is ignored",
    args: { plain: "a" },
    headers: { "Mcp-Param-Plain": "other" },
  },
  {
    name: "header for an unknown param is ignored",
    args: {},
    headers: { "Mcp-Param-Nope": "other" },
  },
];

const REJECTED: Row[] = [
  { name: "string differs", args: { region: "a" }, headers: { "Mcp-Param-Region": "b" } },
  { name: "header missing", args: { region: "a" }, headers: {} },
  { name: "integer differs", args: { count: 1 }, headers: { "Mcp-Param-Count": "2" } },
  {
    name: "integer header not a number",
    args: { count: 1 },
    headers: { "Mcp-Param-Count": "one" },
  },
  { name: "integer header empty", args: { count: 0 }, headers: { "Mcp-Param-Count": "" } },
  { name: "boolean differs", args: { flag: true }, headers: { "Mcp-Param-Flag": "false" } },
  {
    name: "base64 decodes to a different value",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": b64("b") },
  },
  {
    name: "base64 not valid UTF-8",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "=?base64?/w==?=" },
  },
  {
    name: "base64 without padding",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "=?base64?YQ?=" },
  },
  {
    name: "base64 with non-zero trailing bits",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "=?base64?YR==?=" },
  },
  {
    name: "duplicate header (joined by the platform)",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "a, a" },
  },
  { name: "header present but value absent", args: {}, headers: { "Mcp-Param-Region": "a" } },
  {
    name: "header present but value null",
    args: { region: null },
    headers: { "Mcp-Param-Region": "a" },
  },
  {
    name: "object in body for annotated param",
    args: { region: { a: 1 } },
    headers: { "Mcp-Param-Region": "[object Object]" },
  },
  { name: "nested path missing header", args: { nested: { zone: "z" } }, headers: {} },
  {
    name: "non-ASCII byte in plain header",
    args: { region: "é" },
    headers: { "Mcp-Param-Region": "é" },
  },
  {
    name: "control byte in plain header",
    args: { region: "a\u0001b" },
    headers: { "Mcp-Param-Region": "a\u0001b" },
  },
];

describe("Mcp-Param-* validation on a modern tools/call", () => {
  ACCEPTED.forEach(({ name, args, headers }) => {
    it(`accepts: ${name}`, async () => {
      const env = buildParamHandler();
      assert.equal(await ok(await callAnnotated(env, args, headers)), true);
      assert.equal(env.ran.count, 1);
    });
  });

  REJECTED.forEach(({ name, args, headers }) => {
    it(`rejects: ${name}, before the tool runs, without echoing values`, async () => {
      const env = buildParamHandler();
      const response = await callAnnotated(env, args, headers);
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(text).error.code, -32020);
      assert.match(JSON.parse(text).error.message, /^Mcp-Param-\w+ header /);
      assert.equal(/us-west1|\[object|"a"|Hello/.test(text), false);
      assert.equal(env.ran.count, 0);
    });
  });

  it("audits a mismatch with the param_header_mismatch reason", async () => {
    const env = buildParamHandler();
    await callAnnotated(env, { region: "a" }, {});
    assert.deepEqual(env.audits, ["annotated|false|param_header_mismatch"]);
  });

  it("names the invalid-characters fault without echoing the value", async () => {
    const env = buildParamHandler();
    const text = await (
      await callAnnotated(env, { region: "é" }, { "Mcp-Param-Region": "é" })
    ).text();
    assert.equal(
      JSON.parse(text).error.message,
      "Mcp-Param-Region header contains invalid characters",
    );
  });

  it("legacy requests ignore Mcp-Param headers", async () => {
    const env = buildParamHandler();
    const response = await send(env.handler, {
      body: legacyCall("tools/call", { name: "annotated", arguments: { region: "a" } }).body,
      headers: { "Mcp-Param-Region": "different" },
    });
    assert.equal(await ok(response), true);
    assert.equal(env.ran.count, 1);
  });
});
