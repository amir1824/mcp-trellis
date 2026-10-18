import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed-token.js";

const ORIGIN = "https://proto.test";
const PROTOTYPE_KEYS = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];

const auth = signedTokenAuth({
  secret: "prototype-key-test-secret-32-characters-long",
  resolveUser: async () => ({ id: "u1" }),
  loginUrl: () => "/login",
});

const app = createMcpApp<Record<string, never>>({
  serverInfo: { name: "proto", version: "1.0.0" },
  tools: [
    {
      name: "t",
      description: "t",
      inputSchema: { type: "object" },
      scope: "mcp",
      handler: () => "ok",
    },
  ],
  allowInMemoryCodeStore: true,
  auth,
});

const register = async (): Promise<string> => {
  const res = await app.fetch(
    new Request(`${ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9/cb"] }),
    }),
  );
  return ((await res.json()) as { client_id: string }).client_id;
};

describe("attacker-chosen keys never resolve through Object.prototype", () => {
  it("/token answers a prototype-named grant_type with unsupported_grant_type", async () => {
    const clientId = await register();
    for (const grant of PROTOTYPE_KEYS) {
      const res = await app.fetch(
        new Request(`${ORIGIN}/mcp/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: grant, client_id: clientId }),
        }),
      );
      assert.ok(res instanceof Response, `${grant}: not a Response`);
      assert.equal(res.status, 400, grant);
      assert.equal(((await res.json()) as { error: string }).error, "unsupported_grant_type");
    }
  });

  it("an authenticated JSON-RPC method named after a prototype member is 'not found'", async () => {
    const minted = await auth.mintAccessToken({
      userId: "u1",
      clientId: "c",
      scope: "mcp",
      resource: `${ORIGIN}/mcp`,
    });
    for (const method of PROTOTYPE_KEYS) {
      const res = await app.fetch(
        new Request(`${ORIGIN}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${minted.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
        }),
      );
      assert.ok(res instanceof Response, `${method}: not a Response`);
      const body = (await res.json()) as { error?: { code: number } };
      assert.equal(body.error?.code, -32601, method);
    }
  });

  it("an HTTP method named after a prototype member is 405", async () => {
    for (const method of ["constructor", "toString", "hasOwnProperty"]) {
      const res = await app.fetch(new Request(`${ORIGIN}/mcp`, { method }));
      assert.ok(res instanceof Response, `${method}: not a Response`);
      assert.equal(res.status, 405, method);
    }
  });
});
