import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildParamHandler, callAnnotated } from "./harness.js";

const SECRET = "tenant-4417-secret";
const NUMBER = 123456;

type Row = { name: string; args: Record<string, unknown>; headers: Record<string, string> };
const FAULTS: Row[] = [
  { name: "string mismatch", args: { region: SECRET }, headers: { "Mcp-Param-Region": "other" } },
  { name: "header only", args: {}, headers: { "Mcp-Param-Region": SECRET } },
  { name: "missing header", args: { region: SECRET }, headers: {} },
  {
    name: "invalid characters",
    args: { region: SECRET },
    headers: { "Mcp-Param-Region": `${SECRET}é` },
  },
  {
    name: "bad base64",
    args: { region: SECRET },
    headers: { "Mcp-Param-Region": `=?base64?${SECRET}?=` },
  },
  { name: "integer", args: { count: NUMBER }, headers: { "Mcp-Param-Count": SECRET } },
];

describe("a header fault never echoes a header or argument value", () => {
  FAULTS.forEach(({ name, args, headers }) => {
    it(`${name}: response and audit are fixed text`, async () => {
      const env = buildParamHandler();
      const response = await callAnnotated(env, args, headers);
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal(text.includes(SECRET), false);
      assert.equal(text.includes(String(NUMBER)), false);
      assert.equal(env.audits.join("\n").includes(SECRET), false);
      assert.deepEqual(env.audits, ["annotated|false|param_header_mismatch"]);
    });
  });

  it("the two messages are stable", async () => {
    const mismatch = await (await callAnnotated(buildParamHandler(), { region: "a" }, {})).json();
    const invalid = await (
      await callAnnotated(buildParamHandler(), { region: "é" }, { "Mcp-Param-Region": "é" })
    ).json();
    assert.deepEqual(
      [mismatch.error.message, invalid.error.message],
      [
        "Mcp-Param-Region header does not match the request body",
        "Mcp-Param-Region header contains invalid characters",
      ],
    );
  });
});
