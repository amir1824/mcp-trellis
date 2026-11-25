import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import { UI_MIME_TYPE } from "../../../src/mcp/ui/types.js";
import { type Ctx, RESOURCES as UI_DOCUMENTS } from "../ui/harness.js";
import { makeResourceEnv } from "./harness.js";

const valid = (overrides: Record<string, unknown> = {}): ResourceDef<Ctx> =>
  ({ uri: "docs://a", name: "A", read: () => "a", ...overrides }) as ResourceDef<Ctx>;

const build = (...resources: ResourceDef<Ctx>[]) => makeResourceEnv({ resources, withUi: false });

const REJECTED: ReadonlyArray<[string, ResourceDef<Ctx>[], RegExp]> = [
  ["a uri with a space", [valid({ uri: "docs://a b" })], /RFC 3986 ASCII/],
  ["a non-ASCII uri", [valid({ uri: "docs://café" })], /RFC 3986 ASCII/],
  ["an uppercase scheme", [valid({ uri: "Docs://a" })], /lowercase `scheme:`/],
  ["a uri without a scheme", [valid({ uri: "docs" })], /lowercase `scheme:`/],
  ["a uri over 512 characters", [valid({ uri: `docs://${"a".repeat(512)}` })], /over 512/],
  ["a ui:// uri", [valid({ uri: "ui://x/y" })], /ui:\/\/.*uiResources owns/],
  ["a non-string uri", [valid({ uri: 7 })], /uri must be a string/],
  ["a duplicate uri", [valid(), valid()], /duplicate/],
  ["an empty name", [valid({ name: " " })], /name must be a non-empty string/],
  ["a numeric description", [valid({ description: 3 })], /description must be a string/],
  ["a numeric mimeType", [valid({ mimeType: 3 })], /mimeType must be a non-empty string/],
  ["an empty mimeType", [valid({ mimeType: "" })], /mimeType must be a non-empty string/],
  ["the app mime type", [valid({ mimeType: UI_MIME_TYPE })], /uiResources owns/],
  [
    "the app mime type in other case and spacing",
    [valid({ mimeType: " Text/HTML ; Profile=MCP-App " })],
    /uiResources owns/,
  ],
  ["a numeric scope", [valid({ scope: 3 })], /scope must be a string or null/],
  ["a string allow", [valid({ allow: "yes" })], /allow must be a function/],
  ["no read", [valid({ read: undefined })], /read must be a function/],
  ["a non-object entry", [null as unknown as ResourceDef<Ctx>], /resources\[0\] must be an object/],
];

describe("resources config R1 R6", () => {
  for (const [label, resources, expected] of REJECTED) {
    it(`R6 construction rejects ${label}`, () => {
      assert.throws(() => build(...resources), expected);
    });
  }

  it("R6 lists every violation of every entry in one error", () => {
    assert.throws(
      () => build(valid({ uri: "ui://x", name: "" }), valid({ uri: "docs://b", read: 1 })),
      (error: Error) =>
        /invalid resources configuration/.test(error.message) &&
        /resources ui:\/\/x: .*ui:\/\//.test(error.message) &&
        /resources ui:\/\/x: name must be/.test(error.message) &&
        /resources docs:\/\/b: read must be a function/.test(error.message),
    );
  });

  it("R6 rejects resources that is not an array", () => {
    assert.throws(
      () => makeResourceEnv({ resources: {} as unknown as ResourceDef<Ctx>[] }),
      /not an array/,
    );
  });

  it("R6 rejects a general uri equal to a registered ui uri", () => {
    const [firstUi] = UI_DOCUMENTS;
    assert.throws(
      () => makeResourceEnv({ withUi: true, resources: [valid({ uri: firstUi?.uri })] }),
      /uiResources owns/,
    );
  });

  it("R1 accepts a resource with only uri, name and read", () => {
    assert.doesNotThrow(() => build(valid()));
  });

  it("R1 accepts null, undefined and string scopes and an allow function", () => {
    assert.doesNotThrow(() =>
      build(
        valid({ uri: "docs://a", scope: null }),
        valid({ uri: "docs://b", scope: undefined }),
        valid({ uri: "docs://c", scope: "read", allow: () => true }),
      ),
    );
  });

  it("R1 an empty resources list leaves the feature off", async () => {
    const env = build();
    const reply = await env.handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    const { result } = (await reply.json()) as { result: { capabilities: object } };
    assert.deepEqual(result.capabilities, { tools: {} });
  });
});
