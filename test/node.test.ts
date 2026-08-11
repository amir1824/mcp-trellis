import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asNodeHandler,
  resolveOrigin,
  toWebRequest,
  type NodeRequestLike,
  type NodeResponseLike,
} from "../src/adapters/node.js";
import { createMcpHandler } from "../src/dispatch.js";
import { createToolRegistry } from "../src/registry.js";

type MockRes = NodeResponseLike & {
  headers: Record<string, string>;
  chunk: Uint8Array | string | undefined;
};

const mockRes = (): MockRes => {
  const headers: Record<string, string> = {};
  let chunk: Uint8Array | string | undefined;
  const res: MockRes = {
    statusCode: 0,
    headers,
    get chunk() {
      return chunk;
    },
    setHeader(name, value) {
      headers[name.toLowerCase()] = String(value);
    },
    end(body) {
      chunk = body;
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
    assert.equal(
      resolveOrigin(req, { trustProxy: true }),
      "https://public.example.com",
    );
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
    assert.throws(
      () => resolveOrigin({ headers: {} }),
      /Cannot resolve origin/,
    );
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
      resourceMetadataUrl:
        "https://example.test/.well-known/oauth-protected-resource/mcp",
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
    const text =
      typeof res.chunk === "string"
        ? res.chunk
        : new TextDecoder().decode(res.chunk);
    const json = JSON.parse(text) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    assert.equal(json.result.protocolVersion, "2024-11-05");
    assert.equal(json.result.serverInfo.name, "node-test");
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

  it("requires origin or trustProxy", () => {
    assert.throws(() => asNodeHandler(mcp), /requires options.origin/);
  });

  it("derives origin with trustProxy when origin omitted", async () => {
    const handler = asNodeHandler(mcp, { trustProxy: true });
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
});
