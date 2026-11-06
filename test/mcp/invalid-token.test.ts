import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signPayload } from "../../src/auth/signed-payload.js";
import { signedTokenAuth } from "../../src/auth/signed-token.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const LIST = { jsonrpc: "2.0", id: 7, method: "tools/list" };

type Active = (userId: string) => boolean | Promise<boolean>;

const makeApp = (isUserActive?: Active) => {
  const auth = signedTokenAuth({
    secret: HARNESS_CODE_SECRET,
    resolveUser: async () => ({ id: "alice" }),
    loginUrl: () => "/login",
    ...(isUserActive ? { isUserActive } : {}),
  });
  const app = createMcpApp({
    serverInfo: { name: "t", version: "1" },
    auth: { ...auth },
    allowInMemoryCodeStore: true,
    tools: [
      {
        name: "ping_tool",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        scope: "mcp",
        handler: async () => "pong",
      },
    ],
  });
  return { app, auth };
};

const call = (
  app: { fetch: (r: Request) => Promise<Response> },
  headers: Record<string, string>,
  path = "/mcp",
) =>
  app.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(LIST),
    }),
  );

const mintValid = (auth: ReturnType<typeof signedTokenAuth>) =>
  auth.mintAccessToken({ userId: "alice", clientId: "c", scope: "mcp", resource: RESOURCE });

describe("WWW-Authenticate error code on a failed bearer (RFC 6750 §3.1)", () => {
  it("omits the error when no credential was sent", async () => {
    const { app } = makeApp();
    const res = await call(app, {});
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.headers.get("www-authenticate") ?? "", /error=/);
  });

  it("omits the error for a scheme that is not Bearer", async () => {
    const { app } = makeApp();
    const res = await call(app, { Authorization: "Basic YWxpY2U6cHc=" });
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.headers.get("www-authenticate") ?? "", /error=/);
  });

  it("names invalid_token for a bearer that is not a token", async () => {
    const { app } = makeApp();
    const res = await call(app, { Authorization: "Bearer garbage" });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  it("names invalid_token for an expired token, with the same body as any other 401", async () => {
    const { app } = makeApp();
    const expired = await signPayload(HARNESS_CODE_SECRET, "access", {
      userId: "alice",
      scopes: ["mcp"],
      audience: RESOURCE,
      exp: Date.now() - 1000,
    });
    const res = await call(app, { Authorization: `Bearer ${expired}` });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
    const body = (await res.json()) as { error: { message: string }; id: number };
    assert.equal(body.error.message, "Unauthorized");
    assert.equal(body.id, 7);
  });

  it("uses the one code for a wrong audience too", async () => {
    const { app, auth } = makeApp();
    const other = await auth.mintAccessToken({
      userId: "alice",
      clientId: "c",
      scope: "mcp",
      resource: `${ORIGIN}/other`,
    });
    const res = await call(app, { Authorization: `Bearer ${other.accessToken}` });
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  it("does not claim invalid_token for the query-string rejection", async () => {
    const { app, auth } = makeApp();
    const minted = await mintValid(auth);
    const res = await call(app, { Authorization: `Bearer ${minted.accessToken}` }, "/mcp?token=x");
    assert.equal(res.status, 401);
    assert.doesNotMatch(res.headers.get("www-authenticate") ?? "", /error=/);
  });

  it("sends no error for a valid token", async () => {
    const { app, auth } = makeApp();
    const minted = await mintValid(auth);
    const res = await call(app, { Authorization: `Bearer ${minted.accessToken}` });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("www-authenticate"), null);
  });
});

describe("isUserActive on the MCP path", () => {
  it("lets an active user through", async () => {
    const { app, auth } = makeApp(async () => true);
    const minted = await mintValid(auth);
    assert.equal((await call(app, { Authorization: `Bearer ${minted.accessToken}` })).status, 200);
  });

  it("answers 401 invalid_token once the user is no longer active", async () => {
    const active = { value: true };
    const { app, auth } = makeApp(() => active.value);
    const minted = await mintValid(auth);
    active.value = false;
    const res = await call(app, { Authorization: `Bearer ${minted.accessToken}` });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  it("answers 500, never 401 or 200, when the lookup itself fails", async () => {
    const { app, auth } = makeApp(async () => {
      throw new Error("db down");
    });
    const minted = await mintValid(auth);
    const res = await call(app, { Authorization: `Bearer ${minted.accessToken}` });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("www-authenticate"), null);
  });

  it("does not reach the lookup for a bearer that fails the signature", async () => {
    const calls: string[] = [];
    const { app } = makeApp((userId) => {
      calls.push(userId);
      return true;
    });
    await call(app, { Authorization: "Bearer garbage.garbage" });
    assert.deepEqual(calls, []);
  });
});
