/**
 * SCRUM-25 T3, R3 R10 R11 and M3: token audience, scope, and what a revocation reaches. The answers
 * pinned here are the ones that exist at 3.4.0; a change to any of them is a behaviour change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed/token.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const LIST = { jsonrpc: "2.0", id: 7, method: "tools/list" };
const CALL = { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "ping_tool" } };

type Active = (userId: string) => boolean;
type VerifiedUser = { value: boolean };

const makeApp = (isUserActive?: Active, denied: ReadonlySet<string> = new Set()) => {
  const auth = signedTokenAuth({
    secret: HARNESS_CODE_SECRET,
    resolveUser: async () => ({ id: "alice" }),
    loginUrl: () => "/login",
    ...(isUserActive ? { isUserActive } : {}),
  });
  const app = createMcpApp({
    serverInfo: { name: "t", version: "1" },
    auth: {
      ...auth,
      verifyToken: async (token, req) => (denied.has(token) ? null : auth.verifyToken(token, req)),
    },
    allowInMemoryCodeStore: true,
    tools: [
      {
        name: "ping_tool",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        scope: "mcp",
        handler: async () => "pong",
      },
      {
        name: "admin_tool",
        description: "d",
        inputSchema: { type: "object", properties: {} },
        scope: "admin",
        handler: async () => "admin",
      },
    ],
  });
  return { app, auth };
};

const post = (
  app: { fetch: (r: Request) => Promise<Response> },
  token: string,
  body: object = LIST,
) =>
  app.fetch(
    new Request(RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );

const mint = (
  auth: ReturnType<typeof signedTokenAuth>,
  input: { resource?: string; scope?: string } = {},
) =>
  auth.mintAccessToken({
    userId: "alice",
    clientId: "c",
    scope: input.scope ?? "mcp",
    resource: input.resource ?? RESOURCE,
  });

const summary = (res: Response) => [res.status, res.headers.get("www-authenticate")] as const;

describe("R3 M3 audience and scope answers are those of 3.4.0", () => {
  it("R3 M3 a token minted for this resource is accepted", async () => {
    const { app, auth } = makeApp();
    const res = await post(app, (await mint(auth)).accessToken);
    assert.equal(res.status, 200);
  });

  it("R3 M3 R11 a token minted for another resource is refused as invalid_token", async () => {
    const { app, auth } = makeApp();
    const other = await mint(auth, { resource: "https://other.test/mcp" });
    const [status, challenge] = summary(await post(app, other.accessToken));
    assert.equal(status, 401);
    assert.match(challenge ?? "", /error="invalid_token"/);
  });

  it("R3 M3 a token without the tool's scope is a 403 insufficient_scope naming that scope", async () => {
    const { app, auth } = makeApp();
    const token = (await mint(auth)).accessToken;
    const res = await post(app, token, {
      ...CALL,
      params: { name: "admin_tool" },
    });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="insufficient_scope"/);
    assert.match(res.headers.get("www-authenticate") ?? "", /scope="admin"/);
  });

  it("R3 M3 a token that is garbage is refused as invalid_token and never reaches a tool", async () => {
    const { app } = makeApp();
    const res = await post(app, "garbage.garbage", CALL);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });
});

describe("R10 access after a permission is revoked, within the documented token semantics", () => {
  it("R10 a signed access token keeps working until it expires when the host gave no isUserActive", async () => {
    const { app, auth } = makeApp();
    const token = (await mint(auth)).accessToken;
    const res = await post(app, token, CALL);
    assert.equal(res.status, 200);
  });

  it("R10 M3 once isUserActive says the user is gone, the same token is refused at /mcp", async () => {
    const user: VerifiedUser = { value: true };
    const { app, auth } = makeApp(() => user.value);
    const token = (await mint(auth)).accessToken;
    const before = (await post(app, token, CALL)).status;
    user.value = false;
    const after = await post(app, token, CALL);
    assert.deepEqual([before, after.status], [200, 401]);
    assert.match(after.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });

  it("R10 a host denylist in verifyToken refuses a revoked token at /mcp", async () => {
    const denied = new Set<string>();
    const { app, auth } = makeApp(undefined, denied);
    const token = (await mint(auth)).accessToken;
    const before = (await post(app, token, CALL)).status;
    denied.add(token);
    const after = (await post(app, token, CALL)).status;
    assert.deepEqual([before, after], [200, 401]);
  });

  it("R10 a revoked principal's tool is not run, so no tool output reaches the caller", async () => {
    const denied = new Set<string>();
    const { app, auth } = makeApp(undefined, denied);
    const token = (await mint(auth)).accessToken;
    denied.add(token);
    const res = await post(app, token, CALL);
    const body = await res.text();
    assert.deepEqual([res.status, /pong/.test(body)], [401, false]);
  });
});
