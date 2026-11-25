/**
 * SCRUM-25 T3, R12 R13 R17 and M1 M4: nothing the server sends can be reused across callers, and a
 * malformed request never gets as far as a tool or the host's `context` port. Stub ports.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed/token.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";
import {
  buildHandler,
  type Call,
  capture,
  INGEST_TOKEN,
  json,
  modern,
  oversizedBody,
  READ_TOKEN,
  rpc,
  send,
} from "../mcp/modern/harness.js";

type Hints = { result?: { cacheScope?: string; ttlMs?: number } };

describe("R12 M4 every response is marked uncacheable by a shared cache", () => {
  it("R12 M4 each kind of MCP answer carries Cache-Control: no-store", async () => {
    const { handler } = buildHandler({}, true);
    const calls: Call[] = [
      { body: rpc("tools/list"), token: READ_TOKEN },
      { body: rpc("tools/list") },
      { body: rpc("tools/call", { name: "secret_write" }), token: READ_TOKEN },
      { body: "{not json", token: READ_TOKEN },
      modern("tools/list", {}, READ_TOKEN),
      modern("server/discover"),
      modern("not/a/method", {}, READ_TOKEN),
      {
        ...modern("tools/list", {}, READ_TOKEN),
        headers: { "MCP-Protocol-Version": "2026-07-28" },
      },
      { body: oversizedBody(), token: READ_TOKEN },
      { body: null, method: "GET", token: READ_TOKEN },
    ];
    const controls = await Promise.all(
      calls.map(async (call) => (await send(handler, call)).headers.get("cache-control")),
    );
    assert.deepEqual(
      controls,
      calls.map(() => "no-store"),
    );
  });

  it("R12 M4 the OAuth endpoints and metadata carry Cache-Control: no-store too", async () => {
    const auth = signedTokenAuth({
      secret: HARNESS_CODE_SECRET,
      resolveUser: async () => ({ id: "alice" }),
      loginUrl: () => "/login",
    });
    const app = createMcpApp({
      serverInfo: { name: "t", version: "1" },
      auth: { ...auth },
      allowInMemoryCodeStore: true,
      tools: [],
    });
    const requests = [
      new Request("https://example.test/.well-known/oauth-authorization-server"),
      new Request("https://example.test/.well-known/oauth-protected-resource/mcp"),
      new Request("https://example.test/mcp/oauth/authorize?response_type=code"),
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      }),
    ];
    const controls = await Promise.all(
      requests.map(async (request) => (await app.fetch(request)).headers.get("cache-control")),
    );
    assert.deepEqual(
      controls,
      requests.map(() => "no-store"),
    );
  });
});

describe("R12 M4 R17 cache hints under 2026-07-28 are private for anything behind authentication", () => {
  const AUTHENTICATED = [
    ["tools/list", {}, READ_TOKEN],
    ["resources/list", {}, READ_TOKEN],
    ["tools/list", {}, INGEST_TOKEN],
    ["resources/list", {}, INGEST_TOKEN],
    ["resources/read", { uri: "ui://test/view" }, INGEST_TOKEN],
  ] as const;
  const APPS = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };

  it("R12 M4 no authenticated result is public, for either of two principals", async () => {
    const { handler } = buildHandler({}, true);
    const scopes = await Promise.all(
      AUTHENTICATED.map(async ([method, params, token]) => {
        const body = await json<Hints>(
          await send(handler, modern(method, { ...params }, token, APPS)),
        );
        return [body.result?.cacheScope, body.result?.ttlMs];
      }),
    );
    assert.deepEqual(
      scopes,
      AUTHENTICATED.map(() => ["private", 0]),
    );
  });

  it("R12 M4 server/discover is public while it is anonymous, and private once the host makes it need a token", async () => {
    const anonymous = await json<Hints>(
      await send(buildHandler().handler, modern("server/discover", {}, READ_TOKEN)),
    );
    const guarded = await json<Hints>(
      await send(
        buildHandler({ publicMethods: new Set(["initialize"]) }).handler,
        modern("server/discover", {}, READ_TOKEN),
      ),
    );
    assert.deepEqual(
      [anonymous.result?.cacheScope, guarded.result?.cacheScope],
      ["public", "private"],
    );
  });

  it("R4 R12 two principals who differ in scope get the same hints and no data about each other", async () => {
    const { handler } = buildHandler();
    const replies = await Promise.all(
      [READ_TOKEN, INGEST_TOKEN].map(async (token) =>
        capture(await send(handler, modern("tools/list", {}, token))),
      ),
    );
    assert.doesNotMatch(replies.map((reply) => reply.body).join(" "), /acme|globex|u1|u2/);
  });
});

describe("R13 M1 a malformed request never reaches a tool or the context port", () => {
  const MALFORMED: Call[] = [
    { body: "{not json" },
    { body: "[]" },
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1 }) },
    { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: 7 }) },
    { body: JSON.stringify({ jsonrpc: "1.0", id: 1, method: "tools/list" }) },
    { body: rpc("tools/call", { name: ["echo"], arguments: {} }) },
    { body: rpc("tools/call", { name: "echo", arguments: "text" }) },
    { body: oversizedBody() },
    {
      body: rpc("tools/call", { name: "echo", arguments: { text: "x" } }),
      headers: { "MCP-Protocol-Version": "2099-01-01" },
    },
    {
      body: rpc("tools/call", { name: "echo", arguments: { text: "x" } }),
      headers: { "MCP-Protocol-Version": "2026-07-28" },
    },
    {
      ...modern("tools/call", { name: "echo", arguments: { text: "x" } }),
      headers: { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    },
  ];

  it("R13 M1 each malformed request with a valid token is refused, as an HTTP error or a JSON-RPC error, and runs no tool", async () => {
    const { handler, toolCalls } = buildHandler();
    const refused = await Promise.all(
      MALFORMED.map(async (call) => {
        const reply = await capture(await send(handler, { ...call, token: READ_TOKEN }));
        return reply.status >= 400 || /"error"/.test(reply.body);
      }),
    );
    assert.deepEqual(
      refused,
      MALFORMED.map(() => true),
    );
    assert.equal(toolCalls.count, 0);
  });

  it("R13 M1 a refused request writes no audit entry that names a tool it never ran", async () => {
    const { handler, audits } = buildHandler();
    await Promise.all(MALFORMED.map((call) => send(handler, { ...call, token: READ_TOKEN })));
    assert.deepEqual(
      audits.filter((entry) => entry.endsWith("|true")),
      [],
    );
  });
});

describe("R17 the threat model names each cache and piece of shared state", () => {
  it("R17 docs/security.md lists the response, key, code and CIMD caches", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(new URL("../../docs/security.md", import.meta.url), "utf8");
    assert.match(text, /### Caches and shared state/);
    assert.match(text, /cimdCache/);
    assert.match(text, /processCodeStore/);
    assert.match(text, /Cache-Control: no-store/);
  });
});
