import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ADMIN_URI,
  callTool,
  makeEnv,
  OPEN_URI,
  PRODUCTS_URI,
  readResource,
  rpc,
  TOKENS,
} from "./harness.js";

const INSUFFICIENT_SCOPE = -32003;
const INVALID_PARAMS = -32602;
const UNAUTHORIZED = -32001;

describe("R6 users see only their own data and only what their scopes allow", () => {
  it("R6 two principals calling the same UI tool each get only their own structuredContent", async () => {
    const env = makeEnv();
    const alice = await callTool(env, "list_products", TOKENS.alice);
    const bob = await callTool(env, "list_products", TOKENS.bob);
    assert.deepEqual(alice.body.result, {
      content: [{ type: "text", text: "acme has 2 products" }],
      structuredContent: { tenant: "acme", userId: "alice", items: ["a", "b"] },
    });
    assert.deepEqual(bob.body.result, {
      content: [{ type: "text", text: "globex has 2 products" }],
      structuredContent: { tenant: "globex", userId: "bob", items: ["a", "b"] },
    });
  });

  it("R6 arguments naming another user or tenant do not change whose context the tool runs in", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "list_products", TOKENS.alice, {
      tenant: "globex",
      userId: "bob",
    });
    assert.deepEqual(reply.body.result, {
      content: [{ type: "text", text: "acme has 2 products" }],
      structuredContent: { tenant: "acme", userId: "alice", items: ["a", "b"] },
    });
  });

  it("R6 a UI tool call without its scope is a 403 with a step-up challenge, and the tool never runs", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "list_products", TOKENS.eve);
    assert.equal(reply.status, 403);
    assert.equal(reply.body.error?.code, INSUFFICIENT_SCOPE);
    assert.match(reply.challenge ?? "", /error="insufficient_scope"/);
    assert.match(reply.challenge ?? "", /scope="read"/);
    assert.deepEqual(env.contexts, []);
  });

  it("R6 a UI tool call without a token is a 401", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "list_products");
    assert.equal(reply.status, 401);
    assert.equal(reply.body.error?.code, UNAUTHORIZED);
    assert.deepEqual(env.contexts, []);
  });
});

describe("M1 a UI is readable only by a principal who may call one of its tools", () => {
  it("M1 a principal without the scope can neither read nor list the UI, and one with it can", async () => {
    const env = makeEnv();
    const denied = await readResource(env, ADMIN_URI, TOKENS.alice);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error?.code, INSUFFICIENT_SCOPE);
    assert.match(denied.challenge ?? "", /error="insufficient_scope"/);
    assert.match(denied.challenge ?? "", /scope="admin"/);
    assert.doesNotMatch(denied.text, /admin<\/html>/);

    const listed = await rpc(env, "resources/list", undefined, TOKENS.alice);
    assert.doesNotMatch(listed.text, /ui:\/\/shop\/admin/);

    const allowed = await readResource(env, ADMIN_URI, TOKENS.root);
    assert.equal(allowed.status, 200);
    const rootListed = await rpc(env, "resources/list", undefined, TOKENS.root);
    assert.match(rootListed.text, /ui:\/\/shop\/admin/);
  });

  it("M1 a UI whose only tool is unscoped is readable by any authenticated principal, and by nobody else", async () => {
    const env = makeEnv();
    const eve = await readResource(env, OPEN_URI, TOKENS.eve);
    const anonymous = await readResource(env, OPEN_URI);
    assert.equal(eve.status, 200);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(anonymous.text, /open<\/html>/);
  });

  it("M1 a UI referenced by tools scoped read and write is readable with either, not with neither", async () => {
    const env = makeEnv();
    assert.equal((await readResource(env, PRODUCTS_URI, TOKENS.alice)).status, 200);
    assert.equal((await readResource(env, PRODUCTS_URI, TOKENS.carol)).status, 200);
    const neither = await readResource(env, PRODUCTS_URI, TOKENS.eve);
    assert.equal(neither.status, 403);
    assert.match(neither.challenge ?? "", /scope="read"/);
    const eveListed = await rpc(env, "resources/list", undefined, TOKENS.eve);
    assert.doesNotMatch(eveListed.text, /ui:\/\/shop\/products/);
  });

  it("M1 with hideToolsOutsideScope a denied URI answers exactly like an unknown one", async () => {
    const env = makeEnv({ options: { hideToolsOutsideScope: true } });
    const denied = await readResource(env, ADMIN_URI, TOKENS.alice);
    const unknown = await readResource(env, "ui://shop/nope", TOKENS.alice);
    assert.equal(denied.status, 200);
    assert.equal(denied.challenge, null);
    assert.equal(denied.body.error?.code, INVALID_PARAMS);
    assert.equal(denied.body.error?.message, `Unknown resource: ${ADMIN_URI}`);
    assert.equal(unknown.status, denied.status);
    assert.equal(unknown.challenge, null);
    assert.equal(unknown.body.error?.code, INVALID_PARAMS);
    assert.equal(unknown.body.error?.message, "Unknown resource: ui://shop/nope");
    assert.equal((await readResource(env, ADMIN_URI, TOKENS.root)).status, 200);
  });

  it("M1 resources/read never calls the host context port", async () => {
    const env = makeEnv();
    await readResource(env, PRODUCTS_URI, TOKENS.alice);
    await readResource(env, ADMIN_URI, TOKENS.alice);
    await rpc(env, "resources/list", undefined, TOKENS.alice);
    assert.deepEqual(env.contexts, []);
  });
});

describe("M2 an app-only UI tool goes through the same dispatch as any tool", () => {
  it("M2 without the scope the call is a 403 with one audit entry and the handler never runs", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "refresh_products", TOKENS.alice, { category: "toys" });
    assert.equal(reply.status, 403);
    assert.deepEqual(env.contexts, []);
    assert.equal(env.audits.length, 1);
    assert.equal(env.audits[0]?.method, "tools/call");
    assert.equal(env.audits[0]?.tool, "refresh_products");
    assert.equal(env.audits[0]?.principalId, "alice");
    assert.equal(env.audits[0]?.ok, false);
    assert.equal(env.audits[0]?.error, "missing_scope");
  });

  it("M2 with the scope the call validates its arguments and is audited", async () => {
    const env = makeEnv();
    const invalid = await callTool(env, "refresh_products", TOKENS.bob, { category: 5 });
    assert.equal((invalid.body.result as { isError: boolean }).isError, true);

    const valid = await callTool(env, "refresh_products", TOKENS.bob, { category: "toys" });
    assert.deepEqual(valid.body.result, {
      content: [{ type: "text", text: "refreshed toys for bob" }],
      structuredContent: { category: "toys", tenant: "globex" },
    });
    assert.deepEqual(
      env.audits.map(({ tool, principalId, ok }) => ({ tool, principalId, ok })),
      [
        { tool: "refresh_products", principalId: "bob", ok: false },
        { tool: "refresh_products", principalId: "bob", ok: true },
      ],
    );
  });
});

describe("M3 nothing is kept per principal", () => {
  it("M3 interleaved calls by two principals each get only their own result, with a context built per call", async () => {
    const env = makeEnv();
    const [first, second, third] = await Promise.all([
      callTool(env, "list_products", TOKENS.alice),
      callTool(env, "list_products", TOKENS.bob),
      callTool(env, "list_products", TOKENS.alice),
    ]);
    const tenantOf = (reply: { body: { result?: unknown } }) =>
      (reply.body.result as { structuredContent: { tenant: string } }).structuredContent.tenant;
    assert.equal(tenantOf(first), "acme");
    assert.equal(tenantOf(second), "globex");
    assert.equal(tenantOf(third), "acme");
    assert.deepEqual([...env.contexts].sort(), ["alice", "alice", "bob"]);
  });
});

describe("M4 resources are never anonymous", () => {
  const publicResources = new Set(["initialize", "ping", "resources/list", "resources/read"]);

  it("M4 listed in publicMethods, an unauthenticated resources/read and resources/list are still 401", async () => {
    const env = makeEnv({ options: { publicMethods: publicResources } });
    const read = await readResource(env, OPEN_URI);
    const list = await rpc(env, "resources/list");
    assert.equal(read.status, 401);
    assert.equal(list.status, 401);
    assert.doesNotMatch(read.text, /open<\/html>/);
    assert.match(read.challenge ?? "", /Bearer/);
    assert.deepEqual(
      env.audits.map(({ method, ok, error }) => ({ method, ok, error })),
      [
        { method: "resources/read", ok: false, error: "unauthorized" },
        { method: "resources/list", ok: false, error: "unauthorized" },
      ],
    );
  });

  it("M4 listing them in publicMethods does not make them anonymous: even a bearer gets 401 there", async () => {
    // Public methods skip authentication, so the principal is null whatever the request carries.
    const env = makeEnv({ options: { publicMethods: publicResources } });
    const reply = await readResource(env, OPEN_URI, TOKENS.alice);
    assert.equal(reply.status, 401);
    assert.doesNotMatch(reply.text, /open<\/html>/);
  });

  it("M4 a token in the query string is rejected for resources/read and resources/list", async () => {
    const env = makeEnv();
    const query = `?access_token=${TOKENS.alice}`;
    const read = await rpc(env, "resources/read", { uri: OPEN_URI }, TOKENS.alice, query);
    const list = await rpc(env, "resources/list", undefined, TOKENS.alice, query);
    assert.equal(read.status, 401);
    assert.equal(list.status, 401);
    assert.doesNotMatch(read.text, /open<\/html>/);
  });

  it("M4 a valid bearer in the default configuration succeeds", async () => {
    const env = makeEnv();
    assert.equal((await readResource(env, OPEN_URI, TOKENS.alice)).status, 200);
    assert.equal((await rpc(env, "resources/list", undefined, TOKENS.alice)).status, 200);
  });
});
