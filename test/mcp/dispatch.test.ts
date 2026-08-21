import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MCP_BODY_LIMIT } from "../../src/body.js";
import { createMcpHandler } from "../../src/dispatch.js";
import { createToolRegistry } from "../../src/registry.js";

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
      resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
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

  const postWithHeaders = (body: unknown, headers: Record<string, string>) =>
    handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    );

  it("returns -32700 for malformed JSON", async () => {
    const res = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32700);
  });

  it("returns 413 for a body over the 1 MiB /mcp cap, declared via Content-Length", async () => {
    const oversized = "x".repeat(DEFAULT_MCP_BODY_LIMIT + 1);
    const res = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(DEFAULT_MCP_BODY_LIMIT + 1),
        },
        body: oversized,
      }),
    );
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32002);
  });

  it("returns -32601 for an unknown tool name at the HTTP level", async () => {
    const res = await post(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "no-such-tool", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    assert.equal(body.result.isError, true);
    assert.equal(body.result.content[0]?.text, "Unknown tool: no-such-tool");
  });

  it("rejects a missing jsonrpc field with -32600, echoing the id", async () => {
    const res = await post({ id: 10, method: "ping" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { id: unknown; error: { code: number; message: string } };
    assert.equal(body.id, 10);
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /jsonrpc must be "2\.0"/);
  });

  it("rejects a wrong jsonrpc version the same way", async () => {
    const res = await post({ jsonrpc: "1.0", id: 11, method: "ping" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32600);
  });

  it("rejects a missing jsonrpc field with id null when the id itself was omitted", async () => {
    const res = await post({ method: "ping" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { id: unknown };
    assert.equal(body.id, null);
  });

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

  it("defaults to the newest supported version when protocolVersion is omitted or unknown", async () => {
    const omitted = await post({ jsonrpc: "2.0", id: "1b", method: "initialize" });
    const omittedBody = (await omitted.json()) as { result: { protocolVersion: string } };
    assert.equal(omittedBody.result.protocolVersion, "2025-06-18");

    const unknown = await post({
      jsonrpc: "2.0",
      id: "1c",
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const unknownBody = (await unknown.json()) as { result: { protocolVersion: string } };
    assert.equal(unknownBody.result.protocolVersion, "2025-06-18");
  });

  it("returns -32601 for unknown method", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "resources/list" }, "read-tok");
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32601);
  });

  it("returns 401 for unauthenticated tools/call, echoing the request id", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    assert.equal(res.status, 401);
    assert.ok(res.headers.get("WWW-Authenticate")?.includes("resource_metadata"));
    const body = (await res.json()) as { id: unknown };
    assert.equal(body.id, 3);
  });

  it("denies tool when scope missing, echoing the request id", async () => {
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
    const body = (await res.json()) as { id: unknown };
    assert.equal(body.id, 4);
  });

  describe("MCP-Protocol-Version header", () => {
    it("400s on an unsupported header value", async () => {
      const res = await postWithHeaders(
        { jsonrpc: "2.0", id: "v1", method: "resources/list" },
        { "MCP-Protocol-Version": "1999-01-01", Authorization: "Bearer read-tok" },
      );
      assert.equal(res.status, 400);
      const body = (await res.json()) as { id: unknown; error: { code: number; message: string } };
      assert.equal(body.id, "v1");
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /Unsupported MCP-Protocol-Version/);
    });

    it("accepts a supported header value", async () => {
      const res = await postWithHeaders(
        { jsonrpc: "2.0", id: "v2", method: "ping" },
        { "MCP-Protocol-Version": "2025-06-18" },
      );
      assert.equal(res.status, 200);
    });

    it("does not require or validate the header at all — a missing header is fine", async () => {
      const res = await postWithHeaders({ jsonrpc: "2.0", id: "v3", method: "ping" }, {});
      assert.equal(res.status, 200);
    });

    it("is not checked on initialize, which is what negotiates it in the first place", async () => {
      const res = await postWithHeaders(
        { jsonrpc: "2.0", id: "v4", method: "initialize", params: {} },
        { "MCP-Protocol-Version": "not-a-real-version" },
      );
      assert.equal(res.status, 200);
    });
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
    const res = await post({ jsonrpc: "2.0", id: 7, method: "tools/list" }, "read-tok");
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.deepEqual(
      body.result.tools.map((t) => t.name),
      ["echo", "secret_write"],
    );
  });
});

describe("dispatch survives a throwing port", () => {
  type Ctx = { who: string };
  const registry = createToolRegistry<Ctx>([
    {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: {} },
      handler: () => "ok",
    },
  ]);

  const makeHandler = (ports: {
    authenticate: Parameters<typeof createMcpHandler<Ctx>>[0]["ports"]["authenticate"];
    context: Parameters<typeof createMcpHandler<Ctx>>[0]["ports"]["context"];
    audit?: Parameters<typeof createMcpHandler<Ctx>>[0]["ports"]["audit"];
  }) =>
    createMcpHandler<Ctx>({
      registry,
      serverInfo: { name: "throw-test", version: "0.0.1" },
      wwwAuthenticate: {
        realm: "test",
        resourceMetadataUrl: "https://example.test/.well-known/x",
      },
      ports: {
        authenticate: ports.authenticate,
        context: ports.context,
        ...(ports.audit !== undefined ? { audit: ports.audit } : {}),
      },
    });

  const post = (handler: ReturnType<typeof createMcpHandler<Ctx>>) =>
    handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: {} },
        }),
      }),
    );

  it("returns a clean 500 when authenticate throws, instead of rejecting", async () => {
    const audited: string[] = [];
    const handler = makeHandler({
      authenticate: async () => {
        throw new Error("token service is down");
      },
      context: async () => ({ who: "x" }),
      audit: (entry) => {
        audited.push(entry.error ?? "");
      },
    });
    const res = await post(handler);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: number } };
    assert.equal(body.error.code, -32603);
    assert.equal(audited[0], "token service is down");
  });

  it("returns a clean 500 when context throws, instead of rejecting", async () => {
    const handler = makeHandler({
      authenticate: async () => ({ id: "u1", scopes: ["*"] }),
      context: async () => {
        throw new Error("db connection failed");
      },
    });
    const res = await post(handler);
    assert.equal(res.status, 500);
  });
});
