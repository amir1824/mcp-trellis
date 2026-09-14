import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asNodeHandler,
  InvalidOriginError,
  type NodeRequestLike,
  type NodeResponseLike,
  resolveOrigin,
  sendWebResponse,
  toWebRequest,
} from "../../src/adapters/node.js";
import { createMcpHandler } from "../../src/dispatch.js";
import { createOAuthRouter } from "../../src/oauth/router.js";
import { createToolRegistry } from "../../src/registry.js";

type MockRes = NodeResponseLike & {
  headers: Record<string, string | readonly string[]>;
  chunk: Uint8Array | string | undefined;
};

const mockRes = (): MockRes => {
  const headers: Record<string, string | readonly string[]> = {};
  let chunk: Uint8Array | string | undefined;
  const res: MockRes = {
    statusCode: 0,
    headers,
    get chunk() {
      return chunk;
    },
    setHeader(name, value) {
      // Real Node `res.setHeader` keeps an array value as an array (used for
      // `Set-Cookie`) rather than stringifying it — matched here so tests
      // can tell "one setHeader('set-cookie', [...])" apart from "N
      // setHeader('set-cookie', ...) calls each overwriting the last".
      headers[name.toLowerCase()] = Array.isArray(value) ? value : String(value);
    },
    end(body, callback) {
      chunk = body;
      callback?.();
    },
  };
  return res;
};

describe("resolveOrigin", () => {
  it("derives https from Host when trustProxy is false", () => {
    const req: NodeRequestLike = {
      headers: { host: "app.example.com" },
    };
    assert.equal(resolveOrigin(req), "https://app.example.com");
  });

  it("uses last X-Forwarded-Host when trustProxy is true", () => {
    const req: NodeRequestLike = {
      headers: {
        host: "internal:8080",
        "x-forwarded-host": "evil.example.com, public.example.com",
        "x-forwarded-proto": "http, https",
      },
    };
    assert.equal(resolveOrigin(req, { trustProxy: true }), "https://public.example.com");
  });

  it("ignores X-Forwarded-Host when trustProxy is false", () => {
    const req: NodeRequestLike = {
      headers: {
        host: "app.example.com",
        "x-forwarded-host": "evil.example.com",
        "x-forwarded-proto": "http",
      },
    };
    assert.equal(resolveOrigin(req), "https://app.example.com");
  });

  it("throws without host", () => {
    assert.throws(() => resolveOrigin({ headers: {} }), /Cannot resolve origin/);
  });

  it("throws InvalidOriginError specifically, not a generic Error", () => {
    assert.throws(() => resolveOrigin({ headers: {} }), InvalidOriginError);
  });

  it("normalizes an explicit port and host casing through URL", () => {
    const req: NodeRequestLike = { headers: { host: "APP.Example.COM:443" } };
    // Port 443 is the default for https — URL.origin omits a default port.
    assert.equal(resolveOrigin(req), "https://app.example.com");
  });

  it("rejects a Host header carrying a path — not a bare host[:port]", () => {
    const req: NodeRequestLike = { headers: { host: "app.example.com/evil-path" } };
    assert.throws(() => resolveOrigin(req), InvalidOriginError);
  });

  it("rejects a Host header carrying embedded credentials", () => {
    const req: NodeRequestLike = { headers: { host: "user:pass@app.example.com" } };
    assert.throws(() => resolveOrigin(req), InvalidOriginError);
  });

  it("rejects a Host header carrying a query or fragment", () => {
    assert.throws(
      () => resolveOrigin({ headers: { host: "app.example.com?x=1" } }),
      InvalidOriginError,
    );
    assert.throws(
      () => resolveOrigin({ headers: { host: "app.example.com#frag" } }),
      InvalidOriginError,
    );
  });

  it("rejects a non-http(s) X-Forwarded-Proto", () => {
    const req: NodeRequestLike = {
      headers: { host: "app.example.com", "x-forwarded-proto": "javascript" },
    };
    assert.throws(() => resolveOrigin(req, { trustProxy: true }), InvalidOriginError);
  });

  it("rejects a Host header that fails to parse as a URL authority", () => {
    const req: NodeRequestLike = { headers: { host: "not a valid host" } };
    assert.throws(() => resolveOrigin(req), InvalidOriginError);
  });
});

describe("sendWebResponse", () => {
  it("forwards every Set-Cookie, not just the last one", async () => {
    const headers = new Headers();
    headers.append("Set-Cookie", "a=1; Path=/");
    headers.append("Set-Cookie", "b=2; Path=/");
    const response = new Response("ok", { status: 200, headers });

    const res = mockRes();
    await sendWebResponse(res, response);

    assert.deepEqual(res.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"]);
  });

  it("still forwards a single Set-Cookie", async () => {
    const headers = new Headers({ "Set-Cookie": "a=1; Path=/" });
    const response = new Response("ok", { status: 200, headers });

    const res = mockRes();
    await sendWebResponse(res, response);

    assert.deepEqual(res.headers["set-cookie"], ["a=1; Path=/"]);
  });

  it("omits Set-Cookie entirely when the response sets none", async () => {
    const response = new Response("ok", { status: 200 });
    const res = mockRes();
    await sendWebResponse(res, response);
    assert.equal("set-cookie" in res.headers, false);
  });

  it("still forwards ordinary headers unaffected by the Set-Cookie special-case", async () => {
    const headers = new Headers({ "Content-Type": "text/plain" });
    headers.append("Set-Cookie", "a=1");
    const response = new Response("ok", { status: 200, headers });

    const res = mockRes();
    await sendWebResponse(res, response);

    assert.equal(res.headers["content-type"], "text/plain");
  });
});

describe("asNodeHandler", () => {
  const registry = createToolRegistry([
    {
      name: "noop",
      description: "noop",
      inputSchema: { type: "object", properties: {} },
      handler: () => "ok",
    },
  ]);

  const mcp = createMcpHandler({
    registry,
    serverInfo: { name: "node-test", version: "0.0.1" },
    wwwAuthenticate: {
      realm: "test",
      resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
    },
    ports: {
      authenticate: async () => ({ id: "u", scopes: ["*"] }),
      context: async () => ({}),
    },
  });

  it("round-trips initialize via mocked req/res", async () => {
    const handler = asNodeHandler(mcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.ok(res.chunk);
    const text = typeof res.chunk === "string" ? res.chunk : new TextDecoder().decode(res.chunk);
    const json = JSON.parse(text) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    assert.equal(json.result.protocolVersion, "2024-11-05");
    assert.equal(json.result.serverInfo.name, "node-test");
  });

  it("drains the request stream when req.body is absent", async () => {
    // Raw http.createServer never populates `req.body` — it is a stream.
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const streamed = {
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(payload.slice(0, 10));
        yield new TextEncoder().encode(payload.slice(10));
      },
    } as NodeRequestLike;

    const handler = asNodeHandler(mcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(streamed, res);

    assert.equal(res.statusCode, 200);
    const text = typeof res.chunk === "string" ? res.chunk : new TextDecoder().decode(res.chunk);
    const json = JSON.parse(text) as {
      result: { protocolVersion: string };
    };
    assert.equal(json.result.protocolVersion, "2025-06-18");
  });

  it("returns 413 JSON-RPC and destroys only after the response is written", async () => {
    let destroyed = false;
    const oversized = "x".repeat(1_048_577); // DEFAULT_MCP_BODY_LIMIT + 1
    const streamed: NodeRequestLike = {
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      destroy: () => {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(oversized);
      },
    };

    const handler = asNodeHandler(mcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(streamed, res);

    assert.equal(res.statusCode, 413);
    const body = JSON.parse(String(res.chunk)) as { error: { code: number; message: string } };
    assert.equal(body.error.code, -32002);
    assert.equal(destroyed, true, "destroy runs from res.end callback after the 413 is written");
  });

  it("returns 413 on an honest oversized Content-Length before draining the stream", async () => {
    let drained = false;
    const streamed: NodeRequestLike = {
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json", "content-length": "99999999" },
      async *[Symbol.asyncIterator]() {
        drained = true;
        yield new TextEncoder().encode("{}");
      },
    };

    const handler = asNodeHandler(mcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(streamed, res);

    assert.equal(res.statusCode, 413);
    assert.equal(drained, false, "must reject on Content-Length before reading any chunk");
  });

  it("applies the 64 KiB OAuth cap on /mcp/oauth/* paths", async () => {
    const oversized = "x".repeat(65_537);
    const streamed: NodeRequestLike = {
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode(oversized);
      },
    };

    const handler = asNodeHandler(mcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(streamed, res);

    assert.equal(res.statusCode, 413);
    const body = JSON.parse(String(res.chunk)) as { error: string };
    assert.equal(body.error, "request body too large");
  });

  it("explicit origin overrides Host headers", () => {
    const req: NodeRequestLike = {
      method: "GET",
      url: "/mcp",
      headers: { host: "wrong.example" },
    };
    const web = toWebRequest(req, { origin: "https://forced.example" });
    assert.equal(new URL(web.url).origin, "https://forced.example");
  });

  it("rebases absolute-form request targets onto the validated origin", () => {
    const req: NodeRequestLike = {
      method: "GET",
      url: "http://evil.attacker.test/.well-known/oauth-authorization-server",
      headers: { host: "acme.example.com" },
    };
    const web = toWebRequest(req, { origin: "https://acme.example.com" });
    assert.equal(web.url, "https://acme.example.com/.well-known/oauth-authorization-server");
  });

  it("re-serializes a pre-parsed express.urlencoded() body back to form-encoding", async () => {
    // What express.urlencoded() hands the handler for `grant_type=authorization_code&code=abc`.
    const req: NodeRequestLike = {
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { grant_type: "authorization_code", code: "abc" },
    };
    const web = toWebRequest(req, { origin: "https://example.test" });
    assert.equal(await web.text(), "grant_type=authorization_code&code=abc");
  });

  it("repeats an array-valued form field as repeated keys, not a JSON-stringified array", async () => {
    const req: NodeRequestLike = {
      method: "POST",
      url: "/mcp/oauth/register",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { redirect_uris: ["https://a.test/cb", "https://b.test/cb"] },
    };
    const web = toWebRequest(req, { origin: "https://example.test" });
    const params = new URLSearchParams(await web.text());
    assert.deepEqual(params.getAll("redirect_uris"), ["https://a.test/cb", "https://b.test/cb"]);
  });

  it("still JSON-stringifies a pre-parsed body when Content-Type is JSON", async () => {
    const req: NodeRequestLike = {
      method: "POST",
      url: "/mcp/oauth/token",
      headers: { "content-type": "application/json" },
      body: { grant_type: "authorization_code", code: "abc" },
    };
    const web = toWebRequest(req, { origin: "https://example.test" });
    assert.deepEqual(await web.json(), { grant_type: "authorization_code", code: "abc" });
  });

  it("drops a stale Content-Length when the body is re-serialized", () => {
    const req: NodeRequestLike = {
      method: "POST",
      url: "/mcp/oauth/token",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "content-length": "999999",
      },
      body: { grant_type: "authorization_code", code: "abc" },
    };
    const web = toWebRequest(req, { origin: "https://example.test" });
    assert.equal(web.headers.get("content-length"), null);
  });

  it("end-to-end: asNodeHandler + express-style pre-parsed body reaches /token as a real grant, not client_id required", async () => {
    const oauth = createOAuthRouter({
      requireRegisteredClients: false,
      ports: {
        codeSecret: "x".repeat(40),
        resolveUser: async () => ({ id: "u1" }),
        loginUrl: () => "/login",
        mintAccessToken: async () => ({ accessToken: "a", expiresIn: 60 }),
      },
    });
    const handler = asNodeHandler(
      { fetch: async (req) => (await oauth.tryHandle(req)) ?? new Response(null, { status: 404 }) },
      { origin: "https://example.test" },
    );
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: {
          grant_type: "authorization_code",
          code: "not-a-real-code",
          client_id: "c1",
          resource: "https://example.test/mcp",
        },
      },
      res,
    );
    const text = typeof res.chunk === "string" ? res.chunk : new TextDecoder().decode(res.chunk);
    const body = JSON.parse(text) as { error: string; error_description?: string };
    // Reaching "invalid_grant" (not "invalid_request: client_id required") proves the
    // pre-parsed object body was actually understood as a form body, not double-JSON-encoded.
    assert.equal(body.error, "invalid_grant");
  });

  it("requires origin or trustProxy", () => {
    assert.throws(() => asNodeHandler(mcp), /requires options.origin/);
  });

  it("requires allowedOrigins when origin is Host-derived", () => {
    assert.throws(
      () => asNodeHandler(mcp, { trustProxy: true }),
      /requires options.allowedOrigins/,
    );
  });

  it("throws when a fixed origin is absent from allowedOrigins", () => {
    assert.throws(
      () =>
        asNodeHandler(mcp, {
          origin: "https://wrong.example.com",
          allowedOrigins: ["https://acme.example.com"],
        }),
      /not in options.allowedOrigins/,
    );
  });

  it('derives origin with trustProxy and ["*"] when origin omitted', async () => {
    const handler = asNodeHandler(mcp, {
      trustProxy: true,
      allowedOrigins: ["*"],
    });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          host: "derived.example",
          "content-type": "application/json",
        },
        body: { jsonrpc: "2.0", id: 2, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  it("answers a malformed Host header with 400, not 500 — bad client input, not a server fault", async () => {
    const handler = asNodeHandler(mcp, { trustProxy: true, allowedOrigins: ["*"] });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          host: "evil.example/../trusted.example",
          "content-type": "application/json",
        },
        body: { jsonrpc: "2.0", id: 3, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(String(res.chunk)) as { error: string };
    assert.equal(body.error, "origin not allowed");
  });

  it("answers with 500 instead of leaving the connection hanging when fetch throws", async () => {
    // On raw http.createServer, an unhandled rejection here never sends a
    // response at all — the client just hangs until it times out.
    const throwingMcp = {
      fetch: async (): Promise<Response> => {
        throw new Error("downstream is on fire");
      },
    };
    const handler = asNodeHandler(throwingMcp, { origin: "https://example.test" });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: { "content-type": "application/json" },
        body: { jsonrpc: "2.0", id: 1, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(String(res.chunk)) as { error: string };
    assert.equal(body.error, "internal_error");
  });

  it("admits an allowlisted Host-derived origin", async () => {
    const handler = asNodeHandler(mcp, {
      trustProxy: true,
      allowedOrigins: ["https://acme.example.com"],
    });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          host: "acme.example.com",
          "content-type": "application/json",
        },
        body: { jsonrpc: "2.0", id: 2, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  it("admits a Host matching an allowedOrigins wildcard", async () => {
    const handler = asNodeHandler(mcp, {
      trustProxy: true,
      allowedOrigins: ["*.tenants.example.com"],
    });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          host: "acme.tenants.example.com",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: { jsonrpc: "2.0", id: 2, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 200);
  });

  it("rejects a Host outside allowedOrigins with 400", async () => {
    const handler = asNodeHandler(mcp, {
      trustProxy: true,
      allowedOrigins: ["https://acme.example.com"],
    });
    const res = mockRes();
    await handler(
      {
        method: "POST",
        url: "/mcp",
        headers: {
          host: "evil.example.com",
          "content-type": "application/json",
        },
        body: { jsonrpc: "2.0", id: 2, method: "ping" },
      },
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.equal((JSON.parse(String(res.chunk)) as { error: string }).error, "origin not allowed");
  });
});
