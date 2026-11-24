/** A shop server with MCP Apps UIs, built straight on `createMcpHandler`, plus the plumbing to call it. */

import { parseBearer } from "../../../src/auth/bearer.js";
import { createMcpHandler, type McpHandler } from "../../../src/mcp/dispatch.js";
import { createToolRegistry, type ToolDef } from "../../../src/mcp/registry.js";
import type { AuditEntry, McpHandlerOptions, Principal } from "../../../src/mcp/types.js";
import type { UiResource } from "../../../src/mcp/ui/types.js";

export type Ctx = { userId: string; tenant: string };

export const ORIGIN = "https://example.test";

export const TOKENS = {
  alice: "tok-alice",
  bob: "tok-bob",
  carol: "tok-carol",
  eve: "tok-eve",
  root: "tok-root",
} as const;

const PRINCIPALS: Record<string, Principal> = {
  [TOKENS.alice]: { id: "alice", scopes: ["read"], claims: { tenant: "acme" } },
  [TOKENS.bob]: { id: "bob", scopes: ["read", "write"], claims: { tenant: "globex" } },
  [TOKENS.carol]: { id: "carol", scopes: ["write"], claims: { tenant: "initech" } },
  [TOKENS.eve]: { id: "eve", scopes: [] },
  [TOKENS.root]: { id: "root", scopes: ["*"] },
};

export const PRODUCTS_URI = "ui://shop/products";
export const OPEN_URI = "ui://shop/open";
export const ADMIN_URI = "ui://shop/admin";
export const PRODUCTS_HTML = "<!DOCTYPE html><html><body>products</body></html>";
export const CSP = {
  connectDomains: ["https://api.example.com", "wss://live.example.com"],
  resourceDomains: ["https://cdn.example.com", "https://*.example.com"],
};

export const RESOURCES: UiResource[] = [
  {
    uri: PRODUCTS_URI,
    name: "Products",
    description: "Product cards",
    html: PRODUCTS_HTML,
    csp: CSP,
  },
  { uri: OPEN_URI, html: "<html>open</html>" },
  { uri: ADMIN_URI, html: "<html>admin</html>" },
];

const noArgs = { type: "object", properties: {} } as const;

const productsOf = (ctx: Ctx) => ({
  content: [{ type: "text" as const, text: `${ctx.tenant} has 2 products` }],
  structuredContent: { tenant: ctx.tenant, userId: ctx.userId, items: ["a", "b"] },
});

export const UI_TOOLS: ToolDef<Ctx>[] = [
  {
    name: "list_products",
    description: "Show products",
    inputSchema: noArgs,
    scope: "read",
    ui: { resourceUri: PRODUCTS_URI, visibility: ["model", "app"] },
    handler: (ctx) => productsOf(ctx),
  },
  {
    name: "refresh_products",
    description: "Reload products for the UI",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string" } },
      required: ["category"],
    },
    scope: "write",
    ui: { resourceUri: PRODUCTS_URI, visibility: ["app"] },
    handler: (ctx, args) => ({
      content: [{ type: "text", text: `refreshed ${String(args.category)} for ${ctx.userId}` }],
      structuredContent: { category: args.category, tenant: ctx.tenant },
    }),
  },
  {
    name: "open_widget",
    description: "Open to every authenticated principal",
    inputSchema: noArgs,
    scope: null,
    ui: { resourceUri: OPEN_URI },
    handler: () => "open",
  },
  {
    name: "admin_report",
    description: "Admin only",
    inputSchema: noArgs,
    scope: "admin",
    ui: { resourceUri: ADMIN_URI },
    handler: () => "report",
  },
  {
    name: "plain_tool",
    description: "No UI",
    inputSchema: noArgs,
    scope: "read",
    handler: () => "plain",
  },
];

export type Env = { handler: McpHandler; audits: AuditEntry[]; contexts: string[] };

export type EnvInput = {
  tools?: ToolDef<Ctx>[];
  /** `null` leaves `uiResources` out entirely. */
  resources?: UiResource[] | null;
  options?: Partial<McpHandlerOptions<Ctx>>;
};

export const makeEnv = ({
  tools = UI_TOOLS,
  resources = RESOURCES,
  options,
}: EnvInput = {}): Env => {
  const audits: AuditEntry[] = [];
  const contexts: string[] = [];
  const handler = createMcpHandler<Ctx>({
    registry: createToolRegistry(tools),
    serverInfo: { name: "test", version: "0.0.1" },
    instructions: "test server",
    wwwAuthenticate: {
      realm: "test",
      resourceMetadataUrl: `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
    },
    ...(resources === null ? {} : { uiResources: resources }),
    ports: {
      authenticate: async (req) =>
        PRINCIPALS[parseBearer(req.headers.get("authorization")) ?? ""] ?? null,
      context: (_req, principal) => {
        contexts.push(principal?.id ?? "");
        return { userId: principal?.id ?? "", tenant: String(principal?.claims?.tenant ?? "") };
      },
      audit: (entry) => {
        audits.push(entry);
      },
    },
    ...options,
  });
  return { handler, audits, contexts };
};

export type RpcReply = {
  status: number;
  challenge: string | null;
  /** The exact response text, for byte comparisons. */
  text: string;
  body: { id?: unknown; result?: unknown; error?: { code: number; message: string } };
};

export const rpc = async (
  env: Env,
  method: string,
  params?: unknown,
  token?: string,
  query = "",
): Promise<RpcReply> => {
  const res = await env.handler.fetch(
    new Request(`${ORIGIN}/mcp${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  const text = await res.text();
  return {
    status: res.status,
    challenge: res.headers.get("www-authenticate"),
    text,
    body: JSON.parse(text),
  };
};

export const callTool = (env: Env, name: string, token?: string, args: object = {}) =>
  rpc(env, "tools/call", { name, arguments: args }, token);

export const readResource = (env: Env, uri: unknown, token?: string) =>
  rpc(env, "resources/read", { uri }, token);
