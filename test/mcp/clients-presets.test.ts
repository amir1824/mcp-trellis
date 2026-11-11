import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp, type McpApp } from "../../src/app.js";
import { CLAUDE_CALLBACK } from "../../src/oauth/policy/redirect.js";
import { expectOAuthError } from "../helpers/http.js";

const ORIGIN = "https://app.test";
const LOOPBACK_REDIRECT = "http://127.0.0.1:9111/cb";

const makeClaudeApp = (allowLoopback: boolean): McpApp =>
  createMcpApp({
    serverInfo: { name: "presets", version: "1.0.0" },
    tools: [],
    clients: ["claude"],
    allowLoopback,
    allowInMemoryCodeStore: true,
    auth: {
      codeSecret: "app-test-code-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: () => "/login",
      mintAccessToken: async () => ({ accessToken: "t", expiresIn: 3600 }),
      verifyToken: async () => null,
    },
  });

const registerRedirect = (app: McpApp, redirectUri: string): Promise<Response> =>
  app.fetch(
    new Request(`${ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri] }),
    }),
  );

// `clients` selects compatibility presets. It is documented as not an allowlist
// (README, docs/guide.md#locking-down-who-can-register); these tests pin that.
describe("clients are presets, not an allowlist", () => {
  it("registers a loopback client by default even though only claude is named", async () => {
    const res = await registerRedirect(makeClaudeApp(true), LOOPBACK_REDIRECT);

    assert.equal(res.status, 201);
  });

  it("refuses a loopback registration when allowLoopback is false", async () => {
    const res = await registerRedirect(makeClaudeApp(false), LOOPBACK_REDIRECT);

    await expectOAuthError(res, 400, "invalid_redirect_uri");
  });

  it("still registers the Claude callback when allowLoopback is false", async () => {
    const res = await registerRedirect(makeClaudeApp(false), CLAUDE_CALLBACK);

    assert.equal(res.status, 201);
  });
});
