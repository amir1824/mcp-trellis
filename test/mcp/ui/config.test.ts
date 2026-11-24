import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDef } from "../../../src/mcp/registry.js";
import type { UiCsp, UiResource } from "../../../src/mcp/ui/types.js";
import { type Ctx, makeEnv, PRODUCTS_URI, RESOURCES, UI_TOOLS } from "./harness.js";

const tool = (ui: unknown): ToolDef<Ctx> => ({
  name: "t",
  description: "d",
  inputSchema: { type: "object" },
  ui: ui as never,
  handler: () => "x",
});

const resource = (overrides: Partial<UiResource>): UiResource => ({
  uri: "ui://x/y",
  html: "<html></html>",
  ...overrides,
});

const uiTool = (uri: string): ToolDef<Ctx> => tool({ resourceUri: uri });

describe("construction fails closed on a bad UI configuration", () => {
  it("a resourceUri that is not a ui:// URI", () => {
    assert.throws(() =>
      makeEnv({ tools: [tool({ resourceUri: "https://x/y" })], resources: null }),
    );
    assert.throws(() => makeEnv({ tools: [tool({ resourceUri: "ui://" })], resources: null }));
    assert.throws(() => makeEnv({ tools: [tool({ resourceUri: 5 })], resources: null }));
  });

  it("a bad visibility", () => {
    assert.throws(
      () => makeEnv({ tools: [tool({ resourceUri: "ui://x/y", visibility: [] })] }),
      /visibility/,
    );
    assert.throws(
      () => makeEnv({ tools: [tool({ resourceUri: "ui://x/y", visibility: ["admin"] })] }),
      /visibility/,
    );
    assert.throws(
      () => makeEnv({ tools: [tool({ resourceUri: "ui://x/y", visibility: "app" })] }),
      /visibility/,
    );
  });

  it("a tool pointing at an unregistered URI", () => {
    assert.throws(
      () =>
        makeEnv({ tools: [uiTool("ui://x/y")], resources: [resource({ uri: "ui://x/other" })] }),
      /ui:\/\/x\/y is not in uiResources/,
    );
  });

  it("a tool with a ui and no uiResources at all", () => {
    assert.throws(
      () => makeEnv({ tools: [uiTool("ui://x/y")], resources: null }),
      /not in uiResources/,
    );
  });

  it("a registered resource that no tool references", () => {
    assert.throws(
      () =>
        makeEnv({ tools: UI_TOOLS, resources: [...RESOURCES, resource({ uri: "ui://x/lonely" })] }),
      /ui:\/\/x\/lonely is referenced by no tool/,
    );
  });

  it("duplicate URIs", () => {
    assert.throws(
      () => makeEnv({ tools: [uiTool("ui://x/y")], resources: [resource({}), resource({})] }),
      /duplicate uri ui:\/\/x\/y/,
    );
  });

  it("empty html, a non-ui URI and a non-string name", () => {
    const tools = [uiTool("ui://x/y")];
    assert.throws(() => makeEnv({ tools, resources: [resource({ html: "  " })] }), /html/);
    assert.throws(() => makeEnv({ tools, resources: [resource({ uri: "file://x" })] }), /ui:\/\//);
    assert.throws(() => makeEnv({ tools, resources: [resource({ name: 1 as never })] }), /name/);
  });

  it("lists every problem at once", () => {
    assert.throws(
      () =>
        makeEnv({
          tools: [uiTool("ui://x/a")],
          resources: [resource({ uri: "ui://x/b", html: "" })],
        }),
      /html[\s\S]*ui:\/\/x\/a is not in uiResources/,
    );
  });

  it("a valid configuration with several tools on one resource builds", () => {
    assert.doesNotThrow(() => makeEnv());
    assert.equal(UI_TOOLS.filter((t) => t.ui?.resourceUri === PRODUCTS_URI).length, 2);
  });
});

const withCsp = (csp: UiCsp) => () =>
  makeEnv({ tools: [uiTool("ui://x/y")], resources: [resource({ csp })] });
const rejectsResource = (entry: string) =>
  assert.throws(withCsp({ resourceDomains: [entry] }), /csp\.resourceDomains/);
const rejectsConnect = (entry: string) =>
  assert.throws(withCsp({ connectDomains: [entry] }), /csp\.connectDomains/);

describe("M5 CSP origins are exact", () => {
  it("M5 a bare wildcard or a wildcard scheme host is rejected", () => {
    rejectsResource("*");
    rejectsResource("https://*");
    rejectsResource("https://*.com");
    rejectsResource("https://*.*.example.com");
    rejectsConnect("*");
    rejectsConnect("wss://*");
  });

  it("M5 a path, trailing slash, userinfo, explicit default port or upper case is rejected", () => {
    rejectsResource("https://cdn.example.com/lib");
    rejectsResource("https://cdn.example.com/");
    rejectsResource("https://user:pw@cdn.example.com");
    rejectsResource("https://cdn.example.com:443");
    rejectsResource("https://CDN.example.com");
    rejectsResource("https://*.example.com/x");
  });

  it("M5 a space, semicolon or quote smuggled into an entry is rejected", () => {
    rejectsResource("https://cdn.example.com evil.com");
    rejectsResource("https://cdn.example.com;script-src *");
    rejectsResource("https://cdn.example.com'");
    rejectsResource('https://cdn.example.com"');
    rejectsResource("https://cdn.example.com;x");
    rejectsConnect("https://api.example.com evil.com");
  });

  it("M5 'self', data:, http, ftp and other schemes are rejected", () => {
    rejectsResource("'self'");
    rejectsResource("data:");
    rejectsResource("data:text/html,x");
    rejectsResource("http://cdn.example.com");
    rejectsResource("ftp://cdn.example.com");
    rejectsResource("");
    rejectsConnect("ws://api.example.com");
    rejectsConnect("http://api.example.com");
    rejectsConnect("'self'");
  });

  it("M5 wss: is for connectDomains only", () => {
    rejectsResource("wss://live.example.com");
    assert.doesNotThrow(withCsp({ connectDomains: ["wss://live.example.com"] }));
    assert.doesNotThrow(withCsp({ connectDomains: ["wss://*.example.com"] }));
  });

  it("M5 a non-array, a non-string entry and an unknown key are rejected", () => {
    assert.throws(withCsp({ resourceDomains: "https://cdn.example.com" as never }), /array/);
    assert.throws(withCsp({ resourceDomains: [5 as never] }), /csp\.resourceDomains/);
    assert.throws(
      withCsp({ frameDomains: ["https://a.example.com"] } as never),
      /unsupported keys/,
    );
  });

  it("M5 https://cdn.example.com and https://*.example.com are accepted, with a port too", () => {
    assert.doesNotThrow(
      withCsp({
        resourceDomains: [
          "https://cdn.example.com",
          "https://*.example.com",
          "https://a.example.com:8443",
        ],
        connectDomains: ["https://api.example.com", "https://*.example.com"],
      }),
    );
  });
});
