import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../../src/app.js";
import { json, MODERN_VERSION, modern } from "./harness.js";

const ORIGIN = "https://app.test";
const RESOURCE = `${ORIGIN}/mcp`;

const encodeToken = (audience: string): string =>
  Buffer.from(JSON.stringify({ userId: "u1", scopes: ["mcp"], audience })).toString("base64url");

const app = createMcpApp<{ userId: string }>({
  serverInfo: { name: "app-test", version: "1.0.0" },
  tools: [
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      scope: "mcp",
      handler: (_ctx, args) => String(args.text ?? ""),
    },
  ],
  allowInMemoryCodeStore: true,
  auth: {
    codeSecret: "app-test-code-secret-value-32-characters-long",
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async () => ({ accessToken: encodeToken(RESOURCE), expiresIn: 3600 }),
    verifyToken: async (token) => {
      try {
        return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
      } catch {
        return null;
      }
    },
  },
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

const post = (call: ReturnType<typeof modern>) =>
  app.fetch(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(call.token ? { Authorization: `Bearer ${call.token}` } : {}),
        ...call.headers,
      },
      body: JSON.stringify(call.body),
    }),
  );

describe("2026-07-28 through createMcpApp", () => {
  it("R1 R2 R13 a modern server/discover is anonymous and public through the app", async () => {
    const res = await post(modern("server/discover"));
    const body = await json<{ result: { cacheScope: string; supportedVersions: string[] } }>(res);
    assert.equal(res.status, 200);
    assert.equal(body.result.cacheScope, "public");
    assert.equal(body.result.supportedVersions[0], MODERN_VERSION);
  });

  it("R13 R3 a modern tools/list with a token minted for this resource is private", async () => {
    const res = await post(modern("tools/list", {}, encodeToken(RESOURCE)));
    const body = await json<{ result: { cacheScope: string; tools: Array<{ name: string }> } }>(
      res,
    );
    assert.equal(res.status, 200);
    assert.equal(body.result.cacheScope, "private");
    assert.deepEqual(
      body.result.tools.map((tool) => tool.name),
      ["echo"],
    );
  });

  it("R13 a modern tools/list with a token minted for another resource is 401", async () => {
    const res = await post(modern("tools/list", {}, encodeToken("https://other.test/mcp")));
    assert.equal(res.status, 401);
  });

  it("R13 a modern tools/list without a token is 401 with the discovery challenge", async () => {
    const res = await post(modern("tools/list"));
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });
});
