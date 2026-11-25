/**
 * SCRUM-25 T3, R5 R7 R9 and M1: who can reach what, across two tenants, with and without a token,
 * under the older protocol versions and under 2026-07-28. The handler is built straight on
 * `createMcpHandler` with stub ports, so this proves the library's checks, not a host's own.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capture, json, modern, send } from "../mcp/modern/harness.js";
import {
  ADMIN_URI,
  callTool,
  makeEnv,
  PRODUCTS_URI,
  readResource,
  rpc,
  TOKENS,
} from "../mcp/ui/harness.js";

type Result = { structuredContent?: { tenant?: string; userId?: string } };
type Reply = { result?: Result; error?: { code: number } };

describe("R7 users of two tenants never see each other's data", () => {
  it("R7 M1 the same tool called by two tenants runs in each caller's own context, older protocol", async () => {
    const env = makeEnv();
    const acme = await callTool(env, "list_products", TOKENS.alice);
    const globex = await callTool(env, "list_products", TOKENS.bob);
    const tenants = [acme, globex].map((reply) => (reply.body.result as Result).structuredContent);
    assert.deepEqual(tenants, [
      { tenant: "acme", userId: "alice", items: ["a", "b"] },
      { tenant: "globex", userId: "bob", items: ["a", "b"] },
    ]);
  });

  it("R7 M1 the same holds under 2026-07-28, even when the arguments name the other tenant", async () => {
    const env = makeEnv();
    const call = (token: string) =>
      send(
        env.handler,
        modern("tools/call", { name: "list_products", arguments: { tenant: "globex" } }, token),
      ).then(json<Reply>);
    const [acme, globex] = await Promise.all([call(TOKENS.alice), call(TOKENS.bob)]);
    assert.deepEqual(
      [acme.result?.structuredContent?.tenant, globex.result?.structuredContent?.tenant],
      ["acme", "globex"],
    );
  });

  it("R7 each audit entry names only the principal that made the call", async () => {
    const env = makeEnv();
    await callTool(env, "list_products", TOKENS.alice);
    await callTool(env, "list_products", TOKENS.bob);
    await callTool(env, "admin_report", TOKENS.alice);
    assert.deepEqual(
      env.audits.map((entry) => [entry.principalId, entry.tool, entry.ok]),
      [
        ["alice", "list_products", true],
        ["bob", "list_products", true],
        ["alice", "admin_report", false],
      ],
    );
  });

  it("R7 M1 a principal without the scope never runs the tool, so the other tenant's context is never built", async () => {
    const env = makeEnv();
    await callTool(env, "refresh_products", TOKENS.alice, { category: "x" });
    assert.deepEqual(env.contexts, []);
  });
});

describe("R9 a protected resource is not reachable directly", () => {
  it("R9 M1 resources/read with no token is a 401 under the older protocol, and no context is built", async () => {
    const env = makeEnv();
    const reply = await readResource(env, PRODUCTS_URI);
    assert.equal(reply.status, 401);
    assert.deepEqual(env.contexts, []);
  });

  it("R9 M1 resources/read with no token is a 401 under 2026-07-28", async () => {
    const env = makeEnv();
    const res = await send(env.handler, modern("resources/read", { uri: PRODUCTS_URI }));
    assert.equal(res.status, 401);
    assert.deepEqual(env.contexts, []);
  });

  it("R9 a principal that may not read a resource gets the answer for an unknown one, not its content", async () => {
    const env = makeEnv({ options: { hideToolsOutsideScope: true } });
    const hidden = await readResource(env, ADMIN_URI, TOKENS.alice);
    const missing = await readResource(env, "ui://shop/does-not-exist", TOKENS.alice);
    assert.equal(hidden.status, missing.status);
    assert.equal(
      hidden.text.replace(ADMIN_URI, "URI"),
      missing.text.replace("ui://shop/does-not-exist", "URI"),
    );
  });

  it("R4 R9 server/discover without a token carries only static server data", async () => {
    const env = makeEnv();
    const anonymous = await capture(await send(env.handler, modern("server/discover")));
    assert.equal(anonymous.status, 200);
    assert.doesNotMatch(anonymous.body, /acme|globex|alice|bob/);
  });
});

describe("R5 every method is authenticated and audited the same way", () => {
  const PROTECTED_MODERN_METHODS = [
    ["tools/list", {}],
    ["tools/call", { name: "plain_tool", arguments: {} }],
    ["resources/list", {}],
    ["resources/read", { uri: PRODUCTS_URI }],
  ] as const;

  it("R5 each method without a token is refused with 401 and audited as unauthorized, under 2026-07-28", async () => {
    const env = makeEnv();
    const statuses = await Promise.all(
      PROTECTED_MODERN_METHODS.map(
        async ([method, params]) => (await send(env.handler, modern(method, { ...params }))).status,
      ),
    );
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    assert.deepEqual(env.audits.map((entry) => [entry.method, entry.ok, entry.error]).sort(), [
      ["resources/list", false, "unauthorized"],
      ["resources/read", false, "unauthorized"],
      ["tools/call", false, "unauthorized"],
      ["tools/list", false, "unauthorized"],
    ]);
  });

  it("R5 the same methods without a token are also 401 under the older protocol", async () => {
    const env = makeEnv();
    const replies = await Promise.all([
      rpc(env, "tools/list"),
      rpc(env, "tools/call", { name: "plain_tool", arguments: {} }),
      rpc(env, "resources/list"),
      rpc(env, "resources/read", { uri: PRODUCTS_URI }),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.status),
      [401, 401, 401, 401],
    );
  });

  it("R5 the only method a request may call without a token under 2026-07-28 is server/discover", async () => {
    const env = makeEnv();
    const initialize = await send(env.handler, modern("initialize"));
    const ping = await send(env.handler, modern("ping"));
    assert.deepEqual([initialize.status, ping.status], [401, 401]);
  });
});
