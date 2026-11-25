/**
 * Resources next to a tool with an MCP App, for two users of two tenants:
 *
 *   - `docs://handbook`: any signed-in user (scope `mcp`).
 *   - `docs://tenant/summary`: the text is built from `context`, so each user reads their own tenant's.
 *   - `docs://acme/runbook`: `allow` keeps it to one user, whatever the scopes.
 *   - `docs://finance/forecast`: needs the `finance` scope.
 *   - `list_products` has a view (`ui://shop/products`) and a text block for hosts without MCP Apps.
 *
 * `test/resources-example.test.ts` boots this app, so the example stays working. Serve it the way
 * `examples/http-server.ts` does. In an app, import from `mcp-trellis` instead of `../src`.
 * `resolveUser` is a fixed placeholder: replace it with your own session lookup.
 */

import { createMcpApp } from "../src/app.js";
import { signedTokenAuth } from "../src/auth/signed/token.js";
import type { ToolDef } from "../src/mcp/registry.js";
import type { ResourceDef } from "../src/server.js";

type Ctx = { tenant: string };

const TENANTS: Readonly<Record<string, string>> = { alice: "acme", bob: "globex" };
const UNKNOWN_TENANT = "unknown";
const PRODUCTS_URI = "ui://shop/products";

const listProducts: ToolDef<Ctx> = {
  name: "list_products",
  description: "Show the signed-in user's products",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  ui: { resourceUri: PRODUCTS_URI },
  handler: (ctx) => ({
    // A host without MCP Apps shows only this text.
    content: [{ type: "text", text: `2 products for ${ctx.tenant}` }],
    structuredContent: { tenant: ctx.tenant, items: ["Chair", "Desk"] },
  }),
};

const resources: ResourceDef<Ctx>[] = [
  {
    uri: "docs://handbook",
    name: "Handbook",
    mimeType: "text/markdown",
    scope: "mcp",
    read: () => "# Handbook\nBe kind.",
  },
  {
    uri: "docs://tenant/summary",
    name: "Tenant summary",
    scope: "mcp",
    read: (ctx) => `Summary for ${ctx.tenant}`,
  },
  {
    uri: "docs://acme/runbook",
    name: "Acme runbook",
    scope: "mcp",
    allow: (principal) => principal.id === "alice",
    read: () => "Runbook: restart the worker.",
  },
  {
    uri: "docs://finance/forecast",
    name: "Finance forecast",
    scope: "finance",
    read: () => "Forecast: flat.",
  },
];

export const createResourcesDemo = (secret: string) => {
  const auth = signedTokenAuth({
    secret,
    resolveUser: async () => ({ id: "alice" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
  });
  const app = createMcpApp<Ctx>({
    serverInfo: { name: "resources-example", version: "1.0.0" },
    tools: [listProducts],
    uiResources: [{ uri: PRODUCTS_URI, name: "Products", html: "<p>Products</p>" }],
    resources,
    scopes: ["mcp", "finance"],
    defaultScopes: ["mcp"],
    allowInMemoryCodeStore: true,
    auth,
    context: async (_req, principal) => ({
      tenant: TENANTS[principal?.id ?? ""] ?? UNKNOWN_TENANT,
    }),
  });
  return { app, auth };
};
