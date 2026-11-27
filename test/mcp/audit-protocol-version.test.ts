import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpHandler } from "../../src/mcp/dispatch.js";
import { createToolRegistry } from "../../src/mcp/registry.js";
import type { AuditEntry } from "../../src/mcp/types.js";

const makeHandler = (entries: AuditEntry[]) =>
  createMcpHandler({
    registry: createToolRegistry([]),
    serverInfo: { name: "audit-version", version: "0" },
    wwwAuthenticate: {
      realm: "test",
      resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
    },
    ports: {
      authenticate: async () => null,
      context: async () => ({}),
      audit: (entry) => void entries.push(entry),
    },
  });

const listWith = async (header: string, params: unknown = {}) => {
  const entries: AuditEntry[] = [];
  const response = await makeHandler(entries).fetch(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "MCP-Protocol-Version": header },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params }),
    }),
  );
  return { response, entries: entries.map(({ durationMs: _durationMs, ...rest }) => rest) };
};

const refused = (protocolVersion: string) => ({
  method: "tools/list",
  ok: false,
  error: "unsupported_protocol_version",
  protocolVersion,
});

describe("auditing a refused protocol version", () => {
  it("records the version the caller asked for", async () => {
    const { response, entries } = await listWith("2025-11-26");

    assert.equal(response.status, 400);
    assert.deepEqual(entries, [refused("2025-11-26")]);
  });

  it("records the -32022 refusal too", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2099-01-01" };

    const { entries } = await listWith("2099-01-01", { _meta: meta });

    assert.deepEqual(entries, [refused("2099-01-01")]);
  });

  it("clips a version of the caller's choosing", async () => {
    const { entries } = await listWith("9".repeat(5000));

    assert.deepEqual(entries, [refused(`${"9".repeat(32)}…`)]);
  });
});
