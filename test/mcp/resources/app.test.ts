import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp, type McpApp } from "../../../src/app.js";
import type { ResourceBody, ResourceDef } from "../../../src/server.js";

const ORIGIN = "https://app.test";
const TOKEN = "app-token";
const RULE_TOKEN = "other-token";

type Ctx = { userId: string };

const PRINCIPALS: Record<string, { userId: string; scopes: string[] }> = {
  [TOKEN]: { userId: "u1", scopes: ["mcp"] },
  [RULE_TOKEN]: { userId: "u2", scopes: ["mcp"] },
};

const GUIDE: ResourceDef<Ctx> = {
  uri: "docs://app/guide",
  name: "Guide",
  description: "The guide",
  read: (ctx): ResourceBody => ({ text: `guide for ${ctx.userId}`, mimeType: "text/markdown" }),
};

const RULED: ResourceDef<Ctx> = {
  uri: "docs://app/ruled",
  name: "Ruled",
  allow: (principal) => principal.id === "u1",
  read: () => "ruled",
};

const makeApp = (resources?: ResourceDef<Ctx>[]): McpApp =>
  createMcpApp<Ctx>({
    serverInfo: { name: "app-test", version: "1.0.0" },
    tools: [],
    ...(resources === undefined ? {} : { resources }),
    allowInMemoryCodeStore: true,
    auth: {
      codeSecret: "app-test-code-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: () => "/login",
      mintAccessToken: async () => ({ accessToken: TOKEN, expiresIn: 3600 }),
      verifyToken: async (token) => {
        const principal = PRINCIPALS[token];
        return principal === undefined ? null : { ...principal, audience: `${ORIGIN}/mcp` };
      },
    },
    context: (_req, principal) => ({ userId: principal?.id ?? "" }),
  });

const call = async (app: McpApp, method: string, params?: object, token = TOKEN) => {
  const response = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number } };
};

describe("resources app R1 R13 R20", () => {
  it("R1 resources passed to createMcpApp reach the handler: listed and read through the app", async () => {
    const app = makeApp([GUIDE]);
    const list = await call(app, "resources/list");
    const read = await call(app, "resources/read", { uri: GUIDE.uri });
    assert.deepEqual(list.result, {
      resources: [
        { uri: GUIDE.uri, name: "Guide", description: "The guide", mimeType: "text/plain" },
      ],
    });
    assert.deepEqual(read.result, {
      contents: [{ uri: GUIDE.uri, mimeType: "text/markdown", text: "guide for u1" }],
    });
  });

  it("R1 the app's context option builds the context for a general read", async () => {
    const read = await call(makeApp([GUIDE]), "resources/read", { uri: GUIDE.uri }, RULE_TOKEN);
    assert.deepEqual(read.result, {
      contents: [{ uri: GUIDE.uri, mimeType: "text/markdown", text: "guide for u2" }],
    });
  });

  it("R1 an allow rule passed through the app denies as an unknown uri", async () => {
    const app = makeApp([GUIDE, RULED]);
    const denied = await call(app, "resources/read", { uri: RULED.uri }, RULE_TOKEN);
    const allowed = await call(app, "resources/read", { uri: RULED.uri });
    assert.deepEqual([denied.error?.code, allowed.error?.code], [-32602, undefined]);
  });

  it("R13 an app with no resources has no resources capability and answers resources/list as unknown", async () => {
    const app = makeApp();
    const initialize = await call(app, "initialize", {});
    const list = await call(app, "resources/list");
    assert.deepEqual(initialize.result?.capabilities, { tools: {} });
    assert.equal(list.error?.code, -32601);
  });

  it("R20 the new types are exported from the public entry and the capability is additive", async () => {
    const initialize = await call(makeApp([GUIDE]), "initialize", {});
    assert.deepEqual(initialize.result?.capabilities, { tools: {}, resources: {} });
  });
});

const makeMultiScopeApp = (resources: ResourceDef<Ctx>[]): McpApp =>
  createMcpApp<Ctx>({
    serverInfo: { name: "app-test", version: "1.0.0" },
    tools: [],
    resources,
    scopes: ["mcp", "admin"],
    defaultScopes: ["mcp"],
    allowInMemoryCodeStore: true,
    auth: {
      codeSecret: "app-test-code-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: () => "/login",
      mintAccessToken: async () => ({ accessToken: TOKEN, expiresIn: 3600 }),
      verifyToken: async () => null,
    },
  });

describe("resources app R3 R11 a resource with no scope on a multi-scope server", () => {
  it("R3 R11 is refused at construction, naming the resource, like a tool with no scope", () => {
    assert.throws(
      () => makeMultiScopeApp([GUIDE]),
      /these resources have no scope[\s\S]*docs:\/\/app\/guide/,
    );
  });

  it("R3 R11 is accepted once the omission is stated with scope: null", () => {
    assert.doesNotThrow(() => makeMultiScopeApp([{ ...GUIDE, scope: null }]));
  });

  it("R3 R11 is accepted when it names one of the advertised scopes", () => {
    assert.doesNotThrow(() => makeMultiScopeApp([{ ...GUIDE, scope: "mcp" }]));
  });
});

describe("resources app R1 R6 a malformed resources option through createMcpApp", () => {
  const MALFORMED: ReadonlyArray<[string, unknown, RegExp]> = [
    ["a null entry", [null], /resources\[0\] must be an object/],
    ["a non-array", "docs://a", /not an array/],
  ];

  MALFORMED.forEach(([label, resources, expected]) => {
    it(`R6 ${label} is reported by the construction check, not as a raw TypeError`, () => {
      assert.throws(() => makeMultiScopeApp(resources as ResourceDef<Ctx>[]), expected);
    });
  });
});
