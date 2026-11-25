import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  asNodeHandler,
  type NodeRequestLike,
  type NodeResponseLike,
} from "../../../src/adapters/node.js";
import { DEFAULT_MCP_BODY_LIMIT } from "../../../src/http/body.js";
import { buildHandler, MODERN_VERSION } from "./harness.js";

const oversizedRequest = (url: string, headers: Record<string, string>): NodeRequestLike => ({
  method: "POST",
  url,
  headers: { "content-type": "application/json", ...headers },
  destroy: () => {},
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode("x".repeat(DEFAULT_MCP_BODY_LIMIT + 1));
  },
});

const respond = async (req: NodeRequestLike): Promise<{ status: number; body: string }> => {
  let body = "";
  const res: NodeResponseLike = {
    statusCode: 0,
    setHeader: () => {},
    end: (chunk, callback) => {
      body = String(chunk);
      callback?.();
    },
  };
  await asNodeHandler(buildHandler().handler, { origin: "https://example.test" })(req, res);
  return { status: res.statusCode, body };
};

describe("Node adapter and the 2026-07-28 size error", () => {
  it("M3 an oversized body with the modern header is -32600 through asNodeHandler too", async () => {
    const { status, body } = await respond(
      oversizedRequest("/mcp", { "mcp-protocol-version": MODERN_VERSION }),
    );
    assert.equal(status, 413);
    assert.equal((JSON.parse(body) as { error: { code: number } }).error.code, -32600);
  });

  it("M3 M1 the same body without the header, or with an older one, is still -32002", async () => {
    const plain = await respond(oversizedRequest("/mcp", {}));
    const older = await respond(oversizedRequest("/mcp", { "mcp-protocol-version": "2025-06-18" }));
    assert.equal((JSON.parse(plain.body) as { error: { code: number } }).error.code, -32002);
    assert.equal((JSON.parse(older.body) as { error: { code: number } }).error.code, -32002);
  });

  it("M1 an OAuth path keeps its own size error whatever the header says", async () => {
    const { body } = await respond(
      oversizedRequest("/mcp/oauth/token", { "mcp-protocol-version": MODERN_VERSION }),
    );
    assert.deepEqual(JSON.parse(body), { error: "request body too large" });
  });
});
