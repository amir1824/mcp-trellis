import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandler, legacyCall, modernWith, send, UI_ID, withUiDeclared } from "./harness.js";

const bodyOf = async (response: Response) => JSON.parse(await response.text());

type Case = { name: string; extensions: unknown; sees: boolean };
const MODERN_CASES: Case[] = [
  { name: "declared", extensions: withUiDeclared, sees: true },
  { name: "declared with empty settings", extensions: { [UI_ID]: {} }, sees: false },
  {
    name: "mimeTypes lists the app type among others",
    extensions: { [UI_ID]: { mimeTypes: ["text/plain", "text/html;profile=mcp-app"] } },
    sees: true,
  },
  {
    name: "mimeTypes lists only another type",
    extensions: { [UI_ID]: { mimeTypes: ["text/html"] } },
    sees: false,
  },
  {
    name: "mimeTypes is a string that contains the app type",
    extensions: { [UI_ID]: { mimeTypes: "text/html;profile=mcp-app" } },
    sees: false,
  },
  { name: "not declared (no extensions)", extensions: undefined, sees: false },
  {
    name: "other extension only",
    extensions: { "io.modelcontextprotocol/skills": {} },
    sees: false,
  },
];

describe("MCP Apps negotiation on tools/list", () => {
  MODERN_CASES.forEach(({ name, extensions, sees }) => {
    it(`modern, ${name}: _meta.ui present is ${sees}`, async () => {
      const { handler } = buildHandler({}, true);
      const body = await bodyOf(await send(handler, modernWith("tools/list", {}, extensions)));
      const show = body.result.tools.find((tool: { name: string }) => tool.name === "show");
      assert.equal(show._meta !== undefined, sees);
    });
  });

  it("legacy: every client sees _meta.ui", async () => {
    const { handler } = buildHandler({}, true);
    const body = await bodyOf(await send(handler, legacyCall("tools/list")));
    const show = body.result.tools.find((tool: { name: string }) => tool.name === "show");
    assert.equal(show._meta.ui.resourceUri, "ui://test/view");
  });
});

describe("MCP Apps negotiation on resources", () => {
  MODERN_CASES.forEach(({ name, extensions, sees }) => {
    it(`modern, ${name}: list shows the ui document is ${sees}`, async () => {
      const { handler } = buildHandler({}, true);
      const body = await bodyOf(await send(handler, modernWith("resources/list", {}, extensions)));
      assert.equal(body.result.resources.length, sees ? 1 : 0);
    });

    it(`modern, ${name}: read of a ui document succeeds is ${sees}`, async () => {
      const { handler } = buildHandler({}, true);
      const response = await send(
        handler,
        modernWith("resources/read", { uri: "ui://test/view" }, extensions),
      );
      const body = await bodyOf(response);
      assert.equal(body.result !== undefined, sees);
    });
  });

  it("modern, not declared: a ui read answers exactly as an unknown resource", async () => {
    const { handler } = buildHandler({}, true);
    const hidden = await send(handler, modernWith("resources/read", { uri: "ui://test/view" }));
    const unknown = await send(handler, modernWith("resources/read", { uri: "ui://test/missing" }));
    const strip = (text: string) =>
      text.replaceAll("ui://test/view", "X").replaceAll("ui://test/missing", "X");
    assert.equal(hidden.status, unknown.status);
    assert.equal(strip(await hidden.text()), strip(await unknown.text()));
  });

  it("legacy: ui documents are listed and readable", async () => {
    const { handler } = buildHandler({}, true);
    const list = await bodyOf(await send(handler, legacyCall("resources/list")));
    const read = await bodyOf(
      await send(handler, legacyCall("resources/read", { uri: "ui://test/view" })),
    );
    assert.equal(list.result.resources.length, 1);
    assert.equal(read.result.contents[0].text, "<p>view</p>");
  });
});

type Malformed = { name: string; extensions: unknown };
const MALFORMED: Malformed[] = [
  { name: "extensions is a string", extensions: "ui" },
  { name: "extensions is an array", extensions: [UI_ID] },
  { name: "extensions is null", extensions: null },
  { name: "settings is a string", extensions: { [UI_ID]: "yes" } },
  { name: "settings is null", extensions: { [UI_ID]: null } },
  { name: "settings is an array", extensions: { [UI_ID]: ["text/html;profile=mcp-app"] } },
];

describe("malformed extensions in _meta are read as not declared", () => {
  MALFORMED.forEach(({ name, extensions }) => {
    it(`${name}: answers 200 and withholds the ui`, async () => {
      const { handler } = buildHandler({}, true);
      const response = await send(handler, modernWith("tools/list", {}, extensions));
      const body = await bodyOf(response);
      const show = body.result.tools.find((tool: { name: string }) => tool.name === "show");
      assert.equal(response.status, 200);
      assert.equal(show._meta, undefined);
    });
  });

  it("one malformed entry does not hide a valid one next to it", async () => {
    const { handler } = buildHandler({}, true);
    const extensions = { "vendor.example/x": "bad", ...withUiDeclared };
    const body = await bodyOf(await send(handler, modernWith("tools/list", {}, extensions)));
    const show = body.result.tools.find((tool: { name: string }) => tool.name === "show");
    assert.equal(show._meta.ui.resourceUri, "ui://test/view");
  });
});

describe("server declaration of the MCP Apps extension", () => {
  it("server/discover declares it, with empty settings, when a ui document exists", async () => {
    const { handler } = buildHandler({}, true);
    const body = await bodyOf(await send(handler, modernWith("server/discover", {})));
    assert.deepEqual(body.result.capabilities, {
      tools: {},
      resources: {},
      extensions: { [UI_ID]: {} },
    });
  });

  it("initialize declares it too", async () => {
    const { handler } = buildHandler({}, true);
    const body = await bodyOf(await send(handler, legacyCall("initialize", {})));
    assert.deepEqual(body.result.capabilities.extensions, { [UI_ID]: {} });
  });

  it("a server without a ui document declares no extension", async () => {
    const { handler } = buildHandler();
    const body = await bodyOf(await send(handler, modernWith("server/discover", {})));
    assert.deepEqual(body.result.capabilities, { tools: {} });
  });

  it("a server with general resources only declares none", async () => {
    const { handler } = buildHandler({
      resources: [{ uri: "doc://a", name: "a", read: () => "x" }],
    });
    const body = await bodyOf(await send(handler, modernWith("server/discover", {})));
    assert.deepEqual(body.result.capabilities, { tools: {}, resources: {} });
  });
});
