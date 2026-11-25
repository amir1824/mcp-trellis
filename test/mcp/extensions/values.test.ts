import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildParamHandler, callAnnotated } from "./harness.js";

const ok = async (response: Response) => (await response.json()).result !== undefined;
const b64 = (text: string) => `=?base64?${Buffer.from(text).toString("base64")}?=`;

type Row = { name: string; args: Record<string, unknown>; headers: Record<string, string> };

const ACCEPTED: Row[] = [
  { name: "signed integer", args: { count: -7 }, headers: { "Mcp-Param-Count": "-7" } },
  {
    name: "integer with .0 (spec: equal to 42)",
    args: { count: 42 },
    headers: { "Mcp-Param-Count": "42.0" },
  },
  { name: "zero", args: { count: 0 }, headers: { "Mcp-Param-Count": "0" } },
  {
    name: "a BOM-free base64 value matching its body",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": b64("a") },
  },
  {
    name: "largest safe integer",
    args: { count: Number.MAX_SAFE_INTEGER },
    headers: { "Mcp-Param-Count": "9007199254740991" },
  },
  {
    name: "smallest safe integer",
    args: { count: Number.MIN_SAFE_INTEGER },
    headers: { "Mcp-Param-Count": "-9007199254740991" },
  },
  {
    name: "uppercase sentinel is a plain literal, not an encoding",
    args: { region: "=?BASE64?YQ==?=" },
    headers: { "Mcp-Param-Region": "=?BASE64?YQ==?=" },
  },
  {
    name: "sentinel-looking value, base64-encoded",
    args: { region: "=?base64?a b?=" },
    headers: { "Mcp-Param-Region": b64("=?base64?a b?=") },
  },
];

const REJECTED: Row[] = [
  { name: "explicit plus sign", args: { count: 7 }, headers: { "Mcp-Param-Count": "+7" } },
  { name: "integer with .000", args: { count: 42 }, headers: { "Mcp-Param-Count": "42.000" } },
  { name: "leading zeros", args: { count: 42 }, headers: { "Mcp-Param-Count": "042" } },
  { name: "negative zero", args: { count: 0 }, headers: { "Mcp-Param-Count": "-0" } },
  { name: "zero with leading zero", args: { count: 0 }, headers: { "Mcp-Param-Count": "00" } },
  {
    name: "base64 value that decodes to a BOM plus the body",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "=?base64?77u/YQ==?=" },
  },
  { name: "hex integer", args: { count: 42 }, headers: { "Mcp-Param-Count": "0x2A" } },
  { name: "exponent integer", args: { count: 10 }, headers: { "Mcp-Param-Count": "1e1" } },
  { name: "inner space", args: { count: 42 }, headers: { "Mcp-Param-Count": "4 2" } },
  { name: "trailing dot", args: { count: 42 }, headers: { "Mcp-Param-Count": "42." } },
  { name: "leading dot", args: { count: 0 }, headers: { "Mcp-Param-Count": ".0" } },
  { name: "fraction", args: { count: 42 }, headers: { "Mcp-Param-Count": "42.5" } },
  { name: "Infinity", args: { count: 1 }, headers: { "Mcp-Param-Count": "Infinity" } },
  { name: "double sign", args: { count: 1 }, headers: { "Mcp-Param-Count": "+-1" } },
  { name: "separator", args: { count: 1000 }, headers: { "Mcp-Param-Count": "1,000" } },
  {
    name: "body above the safe range, same digits in the header",
    args: { count: 2 ** 53 },
    headers: { "Mcp-Param-Count": "9007199254740992" },
  },
  {
    name: "body below the safe range, same digits in the header",
    args: { count: -(2 ** 53) },
    headers: { "Mcp-Param-Count": "-9007199254740992" },
  },
  {
    name: "body far above the safe range",
    args: { count: 1e21 },
    headers: { "Mcp-Param-Count": "1000000000000000000000" },
  },
  {
    name: "fractional body, matching header",
    args: { count: 1.5 },
    headers: { "Mcp-Param-Count": "1.5" },
  },
  { name: "boolean capitalized", args: { flag: true }, headers: { "Mcp-Param-Flag": "True" } },
  { name: "boolean upper case", args: { flag: false }, headers: { "Mcp-Param-Flag": "FALSE" } },
  { name: "boolean as a digit", args: { flag: true }, headers: { "Mcp-Param-Flag": "1" } },
  {
    name: "plain value shaped like the sentinel but not base64",
    args: { region: "=?base64?a b?=" },
    headers: { "Mcp-Param-Region": "=?base64?a b?=" },
  },
  {
    name: "plain value that is a valid sentinel for another string",
    args: { region: "=?base64?YQ==?=" },
    headers: { "Mcp-Param-Region": "=?base64?YQ==?=" },
  },
  {
    name: "sentinel with an upper-case marker is not decoded",
    args: { region: "a" },
    headers: { "Mcp-Param-Region": "=?BASE64?YQ==?=" },
  },
];

describe("strict Mcp-Param-* values", () => {
  ACCEPTED.forEach(({ name, args, headers }) => {
    it(`accepts: ${name}`, async () => {
      const env = buildParamHandler();
      assert.equal(await ok(await callAnnotated(env, args, headers)), true);
      assert.equal(env.ran.count, 1);
    });
  });

  REJECTED.forEach(({ name, args, headers }) => {
    it(`rejects: ${name}`, async () => {
      const env = buildParamHandler();
      const response = await callAnnotated(env, args, headers);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, -32020);
      assert.equal(env.ran.count, 0);
    });
  });
});
