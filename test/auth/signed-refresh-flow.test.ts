import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed-token.js";
import { createMemoryCodeStore } from "../../src/oauth/crypto/codes.js";
import { expectJson, jsonRpc } from "../helpers/http.js";
import { authorizeCode, redeem } from "../helpers/oauth.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";
import { DEFAULT_ORIGIN } from "../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

type TokenBody = { access_token: string; refresh_token?: string; scope?: string };

const makeApp = (withRefresh: boolean) => {
  const active = { value: true };
  const app = createMcpApp({
    serverInfo: { name: "t", version: "1" },
    requireRegisteredClients: false,
    auth: signedTokenAuth({
      secret: HARNESS_CODE_SECRET,
      resolveUser: async () => ({ id: "alice" }),
      loginUrl: () => "/login",
      codeStore: createMemoryCodeStore(),
      isUserActive: () => active.value,
      ...(withRefresh ? { refreshTtlSeconds: 600 } : {}),
    }),
    tools: [
      {
        name: "who",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        scope: "mcp",
        handler: async () => "ok",
      },
    ],
  });
  return { app, active };
};

const postToken = (
  app: { fetch: (r: Request) => Promise<Response> },
  params: Record<string, string>,
) =>
  app.fetch(
    new Request(`${ORIGIN}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    }),
  );

const connect = async (app: { fetch: (r: Request) => Promise<Response> }) => {
  const session = await authorizeCode(app);
  return expectJson<TokenBody>(await redeem(app, session), 200);
};

const refreshParams = (refreshToken: string) => ({
  grant_type: "refresh_token",
  refresh_token: refreshToken,
  client_id: "harness-client",
  resource: RESOURCE,
});

describe("signedTokenAuth refresh over HTTP", () => {
  it("advertises refresh and revocation, and registers DCR clients for it", async () => {
    const { app } = makeApp(true);
    const meta = await expectJson<{
      grant_types_supported: string[];
      revocation_endpoint?: string;
    }>(await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/mcp`)), 200);
    assert.deepEqual(meta.grant_types_supported, ["authorization_code", "refresh_token"]);
    assert.equal(meta.revocation_endpoint, `${ORIGIN}/mcp/oauth/revoke`);
    const registered = await expectJson<{ grant_types: string[] }>(
      await app.fetch(
        new Request(`${ORIGIN}/mcp/oauth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:4321/cb"] }),
        }),
      ),
      201,
    );
    assert.deepEqual(registered.grant_types, ["authorization_code", "refresh_token"]);
  });

  it("advertises neither by default", async () => {
    const { app } = makeApp(false);
    const meta = await expectJson<{
      grant_types_supported: string[];
      revocation_endpoint?: string;
    }>(await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server/mcp`)), 200);
    assert.deepEqual(meta.grant_types_supported, ["authorization_code"]);
    assert.equal(meta.revocation_endpoint, undefined);
  });

  it("issues a refresh token at the code exchange and rotates it at /token", async () => {
    const { app } = makeApp(true);
    const first = await connect(app);
    assert.ok(first.refresh_token);
    const next = await expectJson<TokenBody>(
      await postToken(app, refreshParams(first.refresh_token)),
      200,
    );
    assert.ok(next.refresh_token && next.refresh_token !== first.refresh_token);
    assert.equal((await jsonRpc(app, TOOLS_LIST, next.access_token)).status, 200);
  });

  it("answers a replayed refresh token with invalid_grant", async () => {
    const { app } = makeApp(true);
    const first = await connect(app);
    await postToken(app, refreshParams(first.refresh_token as string));
    const replay = await postToken(app, refreshParams(first.refresh_token as string));
    const body = await expectJson<{ error: string }>(replay, 400);
    assert.equal(body.error, "invalid_grant");
  });

  it("stops a removed user at the next refresh and at the next tool call", async () => {
    const { app, active } = makeApp(true);
    const first = await connect(app);
    active.value = false;
    const refreshed = await postToken(app, refreshParams(first.refresh_token as string));
    assert.equal((await expectJson<{ error: string }>(refreshed, 400)).error, "invalid_grant");
    assert.equal((await jsonRpc(app, TOOLS_LIST, first.access_token)).status, 401);
  });

  it("revokes the refresh token through /revoke and still answers 200", async () => {
    const { app } = makeApp(true);
    const first = await connect(app);
    const revoked = await app.fetch(
      new Request(`${ORIGIN}/mcp/oauth/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: first.refresh_token as string,
          token_type_hint: "refresh_token",
          client_id: "harness-client",
        }).toString(),
      }),
    );
    assert.equal(revoked.status, 200);
    const after = await postToken(app, refreshParams(first.refresh_token as string));
    assert.equal(after.status, 400);
  });

  it("returns a server error, not a token, when the user lookup fails during refresh", async () => {
    const throwing = createMcpApp({
      serverInfo: { name: "t", version: "1" },
      requireRegisteredClients: false,
      auth: signedTokenAuth({
        secret: HARNESS_CODE_SECRET,
        resolveUser: async () => ({ id: "alice" }),
        loginUrl: () => "/login",
        codeStore: createMemoryCodeStore(),
        isUserActive: () => {
          throw new Error("db down");
        },
        refreshTtlSeconds: 600,
      }),
      tools: [],
    });
    const session = await authorizeCode(throwing);
    const first = await expectJson<TokenBody>(await redeem(throwing, session), 200);
    const res = await postToken(throwing, refreshParams(first.refresh_token as string));
    assert.equal(res.status, 500);
  });
});
