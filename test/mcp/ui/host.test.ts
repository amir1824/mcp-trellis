import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp, type McpApp } from "../../../src/app.js";
import { type Ctx, PRODUCTS_HTML, PRODUCTS_URI, RESOURCES, TOKENS, UI_TOOLS } from "./harness.js";

/**
 * A simulated MCP Apps host. It speaks JSON-RPC to the real `createMcpApp` (routing, audience check,
 * scopes, dispatch) and plays the host's part of the spec from the specification text. It is NOT a
 * real host: no ChatGPT or Claude renders anything here, and no iframe or postMessage bridge runs.
 */
const ORIGIN = "https://app.test";
const UI_EXTENSION = "io.modelcontextprotocol/ui";

type Session = { userId: string; scopes: string[]; claims: Record<string, unknown> };

const SESSIONS: Record<string, Session> = {
  [TOKENS.alice]: { userId: "alice", scopes: ["read"], claims: { tenant: "acme" } },
  [TOKENS.bob]: { userId: "bob", scopes: ["read", "write"], claims: { tenant: "globex" } },
};

const makeApp = (): McpApp =>
  createMcpApp<Ctx>({
    serverInfo: { name: "shop", version: "1.0.0" },
    tools: UI_TOOLS,
    uiResources: RESOURCES,
    clients: ["claude"],
    allowInMemoryCodeStore: true,
    requireRegisteredClients: false,
    auth: {
      codeSecret: "host-test-code-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "alice" }),
      loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, scope }) => ({
        accessToken: userId,
        expiresIn: 3600,
        scope,
      }),
      verifyToken: async (token) => {
        const session = SESSIONS[token];
        return session ? { ...session, audience: `${ORIGIN}/mcp` } : null;
      },
    },
    context: async (_req, principal) => ({
      userId: principal?.id ?? "",
      tenant: String(principal?.claims?.tenant ?? ""),
    }),
  });

type ToolEntry = { name: string; _meta?: { ui?: { resourceUri: string } } };
type HostResult = {
  capabilities?: unknown;
  tools?: ToolEntry[];
  contents?: unknown;
  content?: unknown;
  structuredContent?: unknown;
};
type Reply = { status: number; result: HostResult | undefined };

const hostRpc = async (
  app: McpApp,
  token: string,
  method: string,
  params?: object,
): Promise<Reply> => {
  const res = await app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  const body = (await res.json()) as { result?: HostResult };
  return { status: res.status, result: body.result };
};

/** initialize -> tools/list -> resources/read -> tools/call (UI tool) -> tools/call (second tool). */
const runHost = async (app: McpApp, token: string) => {
  const initialize = await hostRpc(app, token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { [UI_EXTENSION]: { mimeTypes: ["text/html;profile=mcp-app"] } } },
  });
  const list = await hostRpc(app, token, "tools/list");
  const uiTool = list.result?.tools?.find((tool) => tool._meta?.ui?.resourceUri === PRODUCTS_URI);
  const resource = await hostRpc(app, token, "resources/read", { uri: PRODUCTS_URI });
  const toolResult = await hostRpc(app, token, "tools/call", { name: uiTool?.name, arguments: {} });
  const secondTool = await hostRpc(app, token, "tools/call", {
    name: "refresh_products",
    arguments: { category: "toys" },
  });
  return { initialize, list, uiTool, resource, toolResult, secondTool };
};

describe("simulated MCP Apps host", () => {
  it("R3 the host finds the UI in tools/list, reads its html, and hands it the tool result (simulated: a real MCP Apps host is not exercised)", async () => {
    const { initialize, uiTool, resource, toolResult } = await runHost(makeApp(), TOKENS.bob);
    assert.deepEqual(initialize.result?.capabilities, {
      tools: {},
      resources: {},
      extensions: { "io.modelcontextprotocol/ui": {} },
    });
    assert.equal(uiTool?.name, "list_products");
    assert.deepEqual(resource.result?.contents, [
      {
        uri: PRODUCTS_URI,
        mimeType: "text/html;profile=mcp-app",
        text: PRODUCTS_HTML,
        _meta: {
          ui: {
            csp: {
              connectDomains: ["https://api.example.com", "wss://live.example.com"],
              resourceDomains: ["https://cdn.example.com", "https://*.example.com"],
            },
          },
        },
      },
    ]);
    assert.equal(toolResult.status, 200);
  });

  it("R4 the UI gets structuredContent and its callServerTool reaches a second authorized tool", async () => {
    const { toolResult, secondTool } = await runHost(makeApp(), TOKENS.bob);
    assert.deepEqual(toolResult.result?.structuredContent, {
      tenant: "globex",
      userId: "bob",
      items: ["a", "b"],
    });
    assert.deepEqual(secondTool.result, {
      content: [{ type: "text", text: "refreshed toys for bob" }],
      structuredContent: { category: "toys", tenant: "globex" },
    });
  });

  it("R4 the same callServerTool from a user without the second tool's scope is rejected", async () => {
    const { toolResult, secondTool } = await runHost(makeApp(), TOKENS.alice);
    assert.equal(toolResult.status, 200);
    assert.equal(secondTool.status, 403);
    assert.equal(secondTool.result, undefined);
  });

  it("R7 the whole sequence runs through the real app routing, audience check and dispatch; a real host smoke test remains an owner action", async () => {
    // R7's "at least one real supported host is smoke-tested" is NOT covered by any test here.
    const steps = await runHost(makeApp(), TOKENS.bob);
    assert.deepEqual(
      [steps.initialize, steps.list, steps.resource, steps.toolResult, steps.secondTool].map(
        (step) => step.status,
      ),
      [200, 200, 200, 200, 200],
    );
  });

  it("R7 a token this server does not accept gets 401 on resources/read", async () => {
    const app = makeApp();
    const res = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer other" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: PRODUCTS_URI },
        }),
      }),
    );
    assert.equal(res.status, 401);
  });
});
