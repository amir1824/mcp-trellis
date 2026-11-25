# MCP Apps: attach a UI to a tool

A tool can name an HTML view that a host supporting the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) renders in a sandbox beside the tool result. mcp-trellis serves the view and the tool metadata. The host renders it. The view's own requests come back through the host as ordinary `tools/call` requests on your `/mcp` endpoint, so scopes, argument validation, `context` and `audit` apply unchanged.

## Setup

```ts
import { createMcpApp, defineTool, signedTokenAuth } from "mcp-trellis";

const PRODUCTS = "ui://shop/products";

const loadProducts = async (category?: unknown) =>
  ["Chair", "Desk"].map((name) => ({ name, category: category ?? "all" }));

const listProducts = defineTool({
  name: "list_products",
  description: "Show the signed-in user's products",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  ui: { resourceUri: PRODUCTS },
  handler: async () => ({
    content: [{ type: "text", text: "2 products" }], // text fallback for hosts without MCP Apps
    structuredContent: { items: await loadProducts() }, // what the view receives
  }),
});

const refreshProducts = defineTool({
  name: "refresh_products",
  description: "Reload products for the view",
  inputSchema: {
    type: "object",
    properties: { category: { type: "string" } },
    required: ["category"],
  },
  scope: "mcp",
  ui: { resourceUri: PRODUCTS, visibility: ["app"] }, // the host hides it from the model
  handler: async (_ctx, args) => ({
    content: [{ type: "text", text: "refreshed" }],
    structuredContent: { items: await loadProducts(args.category) },
  }),
});

const auth = signedTokenAuth({
  secret: process.env.OAUTH_CODE_SECRET as string, // 32+ characters
  resolveUser: async () => ({ id: "alice" }), // placeholder: use your session lookup
  loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
});

export const app = createMcpApp({
  serverInfo: { name: "shop", version: "1.0.0" },
  auth,
  allowInMemoryCodeStore: true, // single process only; pass a shared codeStore in production
  tools: [listProducts, refreshProducts],
  uiResources: [
    {
      uri: PRODUCTS,
      name: "Products",
      html: "<p>Products</p>", // your built view bundle
      csp: { connectDomains: ["https://api.example.com"] },
    },
  ],
});
```

`createMcpHandler` takes the same `uiResources`. Every resource needs at least one tool that references it, and every tool's `resourceUri` must match a registered resource; otherwise construction throws. Several tools can share one resource.

The view is an HTML bundle you build with the UI-side SDK. This project neither ships nor tests it. The snippet is illustrative: `render` is yours.

```ts
import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "products", version: "1.0.0" });
app.ontoolresult = (result) => render(result.structuredContent);
await app.connect();
const refreshed = await app.callServerTool({ name: "refresh_products", arguments: { category: "toys" } });
```

## What the server does

| Piece | Behavior |
|-------|----------|
| `tools/list` | A tool with `ui` carries `_meta: { ui: { resourceUri, visibility? } }` (nested form only), unless a 2026-07-28 client did not declare the extension (see [Extension negotiation](#extension-negotiation)). Other tools list as before. |
| `initialize`, `server/discover` | Add `resources: {}` to the capabilities when a UI or [`resources`](resources.md) is configured. When a UI is configured they also declare `extensions: { "io.modelcontextprotocol/ui": {} }`; the client's own declaration is what decides what it sees (see [Extension negotiation](#extension-negotiation)). |
| `resources/list` | Bearer required. Lists the UI documents and [general resources](resources.md) the principal may read (a UI document is listed with `uri`, `name`, `description` and its MIME type; no `csp` or `permissions`). Never 403. |
| `resources/read` | Bearer required. Returns `{ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text | blob, _meta?: { ui: { csp, permissions, domain, prefersBorder } } }] }`: `text` for an `html` resource, `blob` for a `blob` one, and only the `_meta.ui` fields you set. Never builds `context` for a `ui://` document. A `uri` that is not a string, or an unknown one, is `-32602`. |
| Audit | Both methods are audited with `method` and `resource` (the URI, clipped to 200 characters). |

A principal may read a UI document if they may call at least one tool that references it. A tool with `scope: null` makes its document readable by any authenticated principal. A denied read is 403 `insufficient_scope` naming the scope of the first referencing tool. With `hideToolsOutsideScope: true` or `"strict"` it answers as an unknown URI. Listing `resources/*` in `publicMethods` does not make them anonymous: they still answer 401.

### Document and display fields

| Field | Type | Meaning |
|-------|------|---------|
| `html` or `blob` | string | Exactly one. `html` is the document text. `blob` is canonical, padded standard base64 of a UTF-8 HTML document; its decoded size is capped at 16 MiB (the cap applies to the decoded bytes, `html` has no cap). Both, neither, a blank document, a `blob` that is not canonical base64 of non-blank UTF-8, or an unknown key throws at construction. |
| `csp` | object | Origins the host lets the UI reach. See below. |
| `permissions` | object | Device access to request: `camera`, `microphone`, `geolocation`, `clipboardWrite`. Each value must be `{}`; any other key or value throws. The server only declares the request: the host decides. |
| `domain` | string | Dedicated sandbox host the UI asks for: a bare lower-case DNS host with an optional port (`map.example.com`). No scheme, path or wildcard. Its meaning is host-defined. |
| `prefersBorder` | boolean | `true` asks the host for a visible border, `false` for none. Omitted leaves it to the host. |

The document is one static string shared by every user. Put per-user data in tool results (`structuredContent`), never in the document.

```ts
import type { UiResource } from "mcp-trellis";

const html = "<!doctype html><title>Map</title><p>Map</p>";

export const mapUi: UiResource = {
  uri: "ui://shop/map",
  name: "Map",
  blob: Buffer.from(html, "utf8").toString("base64"), // html or blob, never both
  csp: {
    connectDomains: ["https://api.example.com"],
    frameDomains: ["https://www.openstreetmap.org"],
    baseUriDomains: ["https://cdn.example.com"],
  },
  permissions: { geolocation: {}, clipboardWrite: {} },
  domain: "map.example.com",
  prefersBorder: true,
};
```

Pass it in `uiResources` next to a tool whose `ui.resourceUri` is `"ui://shop/map"`.

### CSP

Four lists are checked at construction: `connectDomains` (fetch, XHR, WebSocket), `resourceDomains` (scripts, styles, images, fonts, media), `frameDomains` (nested iframes) and `baseUriDomains` (`<base href>` origins). An entry is an exact origin (`https://cdn.example.com`, `https://cdn.example.com:8443`) or one leading wildcard label over a host (`https://*.example.com`). `wss://` is allowed in `connectDomains` only. A bare `*`, a path, credentials, a quote, a space, a `;`, `'self'`, `data:`, any other scheme, or any other `csp` key throws. A list you omit is not sent, and the host's restrictive default applies to it. With no `csp`, no external origin is allowed.

### Extension negotiation

A 2026-07-28 client declares the extensions it supports on each request. The server serves UI only when `io.modelcontextprotocol/ui` is declared with `mimeTypes` that include `text/html;profile=mcp-app`. Otherwise the server omits `_meta.ui` from `tools/list`, leaves the `ui://` documents out of `resources/list`, and answers a `resources/read` of a `ui://` URI as an unknown resource (`-32602`), and the tool behaves as a plain text tool. Clients on 2024-11-05, 2025-03-26 and 2025-06-18 declare nothing per request and see everything. Details: [reference.md](reference.md#client-extensions).

## Tool results

`ToolResult.content` takes the standard blocks: text, image, audio, resource_link, embedded resource. `_meta` must be an object; anything else is replaced by an `isError` result. `structuredContent` may be any JSON value for a 2026-07-28 client, but a client on an older version only gets it when it is an object. Keep a text block in `content`: a host without MCP Apps shows only that. With an `outputSchema`, `structuredContent` must conform: [reference.md](reference.md#tool-results-and-annotations).

## Host compatibility and limits

- MCP Apps support varies by host. No real host (Claude, ChatGPT, the reference `basic-host`, VS Code, MCP Inspector) and no real 2026-07-28 client is run by this project's tests; `test/mcp/ui/host.test.ts` is a harness, not a host. Smoke-test your server in the host you target.
- Protocol versions `2024-11-05`, `2025-03-26` and `2025-06-18`, plus `2026-07-28` behind its own header (see [reference.md](reference.md#2026-07-28-requests)). Any other `MCP-Protocol-Version` gets a 400. The 2026-07-28 path serves the same UI resources.
- Negotiation applies to 2026-07-28 requests only (see [Extension negotiation](#extension-negotiation)). For older versions the server cannot tell, so every client sees `_meta.ui`; a host without MCP Apps ignores it and shows the text result.
- `visibility` is metadata the host enforces. The server cannot tell a model call from a call made by the view, so it never uses `visibility` for authorization.
- The library builds `context` per call from the authenticated principal and keeps no per-user state. Tenant isolation in your data layer is yours.
- Not supported from the MCP Apps spec (2026-01-26): the flat `_meta["ui/resourceUri"]` key. UI documents stay in `resources/list` (the spec lets a server omit them, it does not ask it to).
