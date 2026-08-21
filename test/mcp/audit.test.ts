import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consoleAudit } from "../../src/audit.js";
import { createMcpHandler } from "../../src/dispatch.js";
import type { AuditEntry } from "../../src/methods.js";
import { createToolRegistry } from "../../src/registry.js";

describe("audit port", () => {
  type Ctx = Record<string, never>;

  const makeHandler = (audit?: (entry: AuditEntry) => void) => {
    const registry = createToolRegistry<Ctx>([
      {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        scope: "read",
        handler: () => "ok",
      },
      {
        name: "needs_ingest",
        description: "scoped",
        inputSchema: { type: "object", properties: {} },
        scope: "ingest",
        handler: () => "secret",
      },
    ]);

    return createMcpHandler<Ctx>({
      registry,
      serverInfo: { name: "audit-test", version: "0.0.1" },
      wwwAuthenticate: {
        realm: "test",
        resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
      },
      ports: {
        authenticate: async (req) => {
          const auth = req.headers.get("authorization");
          if (auth === "Bearer read-tok") {
            return { id: "u1", scopes: ["read"] };
          }
          return null;
        },
        context: async () => ({}),
        ...(audit !== undefined ? { audit } : {}),
      },
    });
  };

  const post = (handler: ReturnType<typeof makeHandler>, body: unknown, token?: string) =>
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

  it("audits successful tools/call", async () => {
    const entries: AuditEntry[] = [];
    const handler = makeHandler((e) => {
      entries.push(e);
    });
    const res = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(res.status, 200);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, true);
    assert.equal(entries[0]?.tool, "echo");
    assert.equal(entries[0]?.principalId, "u1");
  });

  it("audits null authenticate", async () => {
    const entries: AuditEntry[] = [];
    const handler = makeHandler((e) => {
      entries.push(e);
    });
    const res = await post(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    assert.equal(res.status, 401);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.equal(entries[0]?.error, "unauthorized");
  });

  it("audits missing scope", async () => {
    const entries: AuditEntry[] = [];
    const handler = makeHandler((e) => {
      entries.push(e);
    });
    const res = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "needs_ingest", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(res.status, 401);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.ok, false);
    assert.equal(entries[0]?.error, "missing_scope");
    assert.equal(entries[0]?.tool, "needs_ingest");
  });

  it("does not throw when audit port is omitted", async () => {
    const handler = makeHandler();
    const res = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(res.status, 200);
  });

  it("a throwing audit port never fails the request", async () => {
    const handler = makeHandler(() => {
      throw new Error("telemetry sink down");
    });

    const ok = await post(
      handler,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      },
      "read-tok",
    );
    assert.equal(ok.status, 200);

    // The denial path audits too — it must stay a clean 401.
    const denied = await post(handler, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    });
    assert.equal(denied.status, 401);
  });

  it("a hanging audit port does not stall the response past auditTimeoutMs", async () => {
    const registry = createToolRegistry<Ctx>([
      {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        handler: () => "ok",
      },
    ]);
    const handler = createMcpHandler<Ctx>({
      registry,
      serverInfo: { name: "audit-timeout-test", version: "0.0.1" },
      wwwAuthenticate: {
        realm: "test",
        resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
      },
      // A 200 while the sink never resolves is the proof the race timer won.
      auditTimeoutMs: 150,
      ports: {
        authenticate: async () => ({ id: "u1", scopes: [] }),
        context: async () => ({}),
        audit: () => new Promise<void>(() => {}), // never resolves
      },
    });

    const res = await post(
      handler,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } },
      "irrelevant",
    );
    assert.equal(res.status, 200);
  });

  it("a slow audit port that resolves after the timeout never becomes an unhandled rejection", async () => {
    let auditFinished = false;
    const registry = createToolRegistry<Ctx>([
      {
        name: "echo",
        description: "echo",
        inputSchema: { type: "object", properties: {} },
        handler: () => "ok",
      },
    ]);
    const handler = createMcpHandler<Ctx>({
      registry,
      serverInfo: { name: "audit-timeout-test", version: "0.0.1" },
      wwwAuthenticate: {
        realm: "test",
        resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
      },
      auditTimeoutMs: 20,
      ports: {
        authenticate: async () => ({ id: "u1", scopes: [] }),
        context: async () => ({}),
        audit: () =>
          new Promise<void>((_resolve, reject) => {
            setTimeout(() => {
              auditFinished = true;
              reject(new Error("audit sink failed, arriving late"));
            }, 60);
          }),
      },
    });

    let unhandled: unknown;
    const onUnhandled = (reason: unknown) => {
      unhandled = reason;
    };
    process.once("unhandledRejection", onUnhandled);
    try {
      const res = await post(
        handler,
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: {} } },
        "irrelevant",
      );
      assert.equal(res.status, 200);
      // Wait well past the audit's 60ms delay so a loaded event loop still settles.
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(auditFinished, true, "the slow audit call should still run to completion");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, undefined, "a late audit rejection must never surface as unhandled");
  });

  it("audits a query-string token on POST", async () => {
    const entries: AuditEntry[] = [];
    const handler = makeHandler((e) => {
      entries.push(e);
    });
    const res = await handler.fetch(
      new Request("https://example.test/mcp?access_token=leaked", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      }),
    );
    assert.equal(res.status, 401);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.error, "query_string_token");
    assert.equal(entries[0]?.method, "");
  });

  it("audits an unauthenticated GET", async () => {
    const entries: AuditEntry[] = [];
    const handler = makeHandler((e) => {
      entries.push(e);
    });
    const res = await handler.fetch(new Request("https://example.test/mcp", { method: "GET" }));
    assert.equal(res.status, 401);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.error, "unauthorized");
  });
});

describe("tool error redaction", () => {
  it("defaults to redacted message", async () => {
    const registry = createToolRegistry([
      {
        name: "boom",
        description: "throws",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          throw new Error("postgres://user:pass@host/db");
        },
      },
    ]);
    const result = await registry.call("boom", {}, {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Tool execution failed");
  });

  it("falls back to the default when onToolError throws", async () => {
    const registry = createToolRegistry(
      [
        {
          name: "boom",
          description: "throws",
          inputSchema: { type: "object", properties: {} },
          handler: () => {
            throw new Error("secret-detail");
          },
        },
      ],
      {
        onToolError: () => {
          throw new Error("mapper is broken");
        },
      },
    );
    const result = await registry.call("boom", {}, {});
    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.text, "Tool execution failed");
  });

  it("falls back to the default when onToolError returns empty", async () => {
    const registry = createToolRegistry(
      [
        {
          name: "boom",
          description: "throws",
          inputSchema: { type: "object", properties: {} },
          handler: () => {
            throw new Error("secret-detail");
          },
        },
      ],
      { onToolError: () => "" },
    );
    const result = await registry.call("boom", {}, {});
    assert.equal(result.content[0]?.text, "Tool execution failed");
  });

  it("uses onToolError when provided", async () => {
    const registry = createToolRegistry(
      [
        {
          name: "boom",
          description: "throws",
          inputSchema: { type: "object", properties: {} },
          handler: () => {
            throw new Error("secret-detail");
          },
        },
      ],
      { onToolError: (exc) => `mapped:${exc instanceof Error ? exc.message : ""}` },
    );
    const result = await registry.call("boom", {}, {});
    assert.equal(result.content[0]?.text, "mapped:secret-detail");
  });
});

describe("consoleAudit", () => {
  it("logs successes to console.log", (t) => {
    const log = t.mock.method(console, "log", () => {});
    const error = t.mock.method(console, "error", () => {});

    consoleAudit({
      method: "tools/call",
      tool: "echo",
      principalId: "u1",
      ok: true,
      durationMs: 12,
    });

    assert.equal(log.mock.callCount(), 1);
    assert.equal(error.mock.callCount(), 0);
    assert.match(
      log.mock.calls[0]?.arguments[0] as string,
      /^\[mcp-trellis\] tools\/call tool=echo ok 12ms user=u1$/,
    );
  });

  it("logs failures to console.error, including transport denials", (t) => {
    const log = t.mock.method(console, "log", () => {});
    const error = t.mock.method(console, "error", () => {});

    consoleAudit({
      method: "",
      ok: false,
      error: "unauthorized",
      durationMs: 0,
    });

    assert.equal(log.mock.callCount(), 0);
    assert.equal(error.mock.callCount(), 1);
    assert.match(
      error.mock.calls[0]?.arguments[0] as string,
      /^\[mcp-trellis\] \(transport\) fail 0ms error=unauthorized$/,
    );
  });

  it("wires straight into the audit port", async (t) => {
    const error = t.mock.method(console, "error", () => {});
    const registry = createToolRegistry<Record<string, never>>([
      {
        name: "boom",
        description: "throws",
        inputSchema: { type: "object", properties: {} },
        handler: () => {
          throw new Error("secret-detail");
        },
      },
    ]);
    const handler = createMcpHandler({
      registry,
      serverInfo: { name: "t", version: "0" },
      wwwAuthenticate: {
        realm: "t",
        resourceMetadataUrl: "https://example.test/.well-known/x",
      },
      ports: {
        authenticate: async () => ({ id: "u1", scopes: ["*"] }),
        context: async () => ({}),
        audit: consoleAudit,
      },
    });

    await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer x",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "boom", arguments: {} },
        }),
      }),
    );

    assert.equal(error.mock.callCount(), 1);
    const line = error.mock.calls[0]?.arguments[0] as string;
    assert.match(
      line,
      /^\[mcp-trellis\] tools\/call tool=boom fail \d+ms user=u1 error=Tool execution failed$/,
    );
  });
});

describe("explicit null id", () => {
  it("returns RPC error for unknown method with id null", async () => {
    const handler = createMcpHandler({
      registry: createToolRegistry([]),
      serverInfo: { name: "t", version: "0" },
      wwwAuthenticate: {
        realm: "t",
        resourceMetadataUrl: "https://example.test/.well-known/x",
      },
      ports: {
        authenticate: async () => ({ id: "u", scopes: ["*"] }),
        context: async () => ({}),
      },
    });
    const res = await handler.fetch(
      new Request("https://example.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer x",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: null, method: "x" }),
      }),
    );
    assert.notEqual(res.status, 202);
    const body = (await res.json()) as {
      id: null;
      error: { code: number };
    };
    assert.equal(body.id, null);
    assert.equal(body.error.code, -32601);
  });
});
