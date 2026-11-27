import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpHandler } from "../../src/mcp/dispatch.js";
import { createToolRegistry } from "../../src/mcp/registry.js";

const VERSION = "2025-11-25";

const handler = createMcpHandler({
  registry: createToolRegistry([
    {
      name: "echo",
      description: "echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: () => "ok",
    },
  ]),
  serverInfo: { name: "v", version: "0" },
  wwwAuthenticate: { realm: "r", resourceMetadataUrl: "https://example.test/metadata" },
  ports: { authenticate: async () => ({ id: "u", scopes: [] }), context: async () => ({}) },
});

const send = async (method: string, params: unknown) => {
  const response = await handler.fetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      result?: { protocolVersion?: string; isError?: boolean };
    },
  };
};

describe("a client on 2025-11-25", () => {
  it("gets its own version back from initialize", async () => {
    const { body } = await send("initialize", { protocolVersion: VERSION });

    assert.equal(body.result?.protocolVersion, VERSION);
  });

  it("is served on later requests that carry the version header", async () => {
    const { status } = await send("tools/list", {});

    assert.equal(status, 200);
  });

  it("gets invalid arguments as a tool error the model can read, not a protocol error", async () => {
    const { body } = await send("tools/call", { name: "echo", arguments: {} });

    assert.equal(body.result?.isError, true);
  });
});
