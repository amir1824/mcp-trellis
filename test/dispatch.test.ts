import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolRegistry } from "../src/registry.js";
import { createMcpHandler } from "../src/dispatch.js";

describe("dispatch", () => {
  type Ctx = { who: string };

  const registry = createToolRegistry<Ctx>(
    [
      {
        name: "echo",
        description: "echo args",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        scope: "read",
        handler: (_ctx, args) => String(args.text ?? ""),
      },
      {
        name: "secret_write",
        description: "needs ingest",
        inputSchema: { type: "object", properties: {} },
        scope: "ingest",
        handler: () => "written",
      },
    ],
    { validateArgs: true },
  );

  const handler = createMcpHandler<Ctx>({
    registry,
    serverInfo: { name: "test", version: "0.0.1" },
    instructions: "test server",
    wwwAuthenticate: {
      realm: "test",
      resourceMetadataUrl:
        "https://example.test/.well-known/oauth-protected-resource/mcp",
    },
    ports: {
      authenticate: async (req, _method, tool) => {
        const auth = req.headers.get("authorization");
        if (auth === "Bearer read-tok") {
          return { id: "u1", scopes: ["read"] };
        }
        if (auth === "Bearer ingest-tok") {
          return { id: "u1", scopes: ["ingest", "read"] };
        }
        void tool;
        return null;
      },
      context: async () => ({ who: "tester" }),
    },
  });

  const post = (body: unknown, token?: string) =>
    handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  it("returns 202 for notifications", async () => {
    const res = await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    assert.equal(res.status, 202);
    assert.equal(await res.text(), "");
  });

  it("rejects batches", async () => {
    const res = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32600);
  });

  it("negotiates protocol version on initialize (public)", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result: { protocolVersion: string };
    };
    assert.equal(body.result.protocolVersion, "2025-03-26");
  });

  it("returns -32601 for unknown method", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
      "read-tok",
    );
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32601);
  });

  it("returns 401 for unauthenticated tools/call", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    assert.equal(res.status, 401);
    assert.ok(res.headers.get("WWW-Authenticate")?.includes("resource_metadata"));
  });

  it("denies tool when scope missing", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "secret_write", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(res.status, 401);
  });

  it("calls tool when scope present and validates args", async () => {
    const ok = await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      "read-tok",
    );
    const okBody = (await ok.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(okBody.result.content[0]?.text, "hi");

    const bad = await post(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      },
      "read-tok",
    );
    const badBody = (await bad.json()) as {
      result: { isError: boolean };
    };
    assert.equal(badBody.result.isError, true);
  });

  it("lists tools when authenticated", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 7, method: "tools/list" },
      "read-tok",
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      ["echo", "secret_write"],
    );
  });
});
