# MCP Apps: attach a UI to a tool

A tool can name an HTML view that a host supporting the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps) renders in a sandbox beside the tool result. mcp-trellis serves the view and the metadata. The host renders it. The view's own requests come back through the host as ordinary `tools/call` requests on your `/mcp` endpoint.

## Setup

```ts
import { createMcpApp, defineTool } from "mcp-trellis";

const PRODUCTS = "ui://shop/products";

const listProducts = defineTool({
  name: "list_products",
  description: "Show the signed-in user's products",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  ui: { resourceUri: PRODUCTS },
  handler: async (ctx) => ({
    content: [{ type: "text", text: "2 products" }],
    structuredContent: { items: await loadProducts(ctx) },
  }),
});

const refreshProducts = defineTool({
  name: "refresh_products",
  description: "Reload products for the view",
  inputSchema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] },
  scope: "mcp",
  ui: { resourceUri: PRODUCTS, visibility: ["app"] }, // hidden from the model by the host
  handler: async (ctx, args) => ({
    content: [{ type: "text", text: "refreshed" }],
    structuredContent: { items: await loadProducts(ctx, args.category) },
  }),
});

createMcpApp({
  // ...serverInfo, auth, context
  tools: [listProducts, refreshProducts],
  uiResources: [{ uri: PRODUCTS, name: "Products", html: productsHtml, csp: { connectDomains: ["https://api.example.com"] } }],
});
```

`createMcpHandler` takes the same `uiResources`. A resource needs at least one referencing tool; a tool's `resourceUri` must match a registered resource. Several tools can share one resource.

### The view (illustrative)

The view is an HTML bundle you build with the UI-side SDK. This snippet is illustrative: this project neither ships nor tests it.

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
| `tools/list` | A tool with `ui` carries `_meta: { ui: { resourceUri, visibility? } }` (nested form only). Other tools list exactly as before. |
| `initialize` | Adds `resources: {}` to the capabilities, only when a UI or [`resources`](resources.md) is configured. The server does not declare the MCP Apps extension; clients advertise it. |
| `resources/list` | Bearer required. Lists the resources the principal may read (UI documents and, if configured, [general resources](resources.md)). Never a 403. |
| `resources/read` | Bearer required. Returns `{ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text, _meta?: { ui: { csp } } }] }`. Never calls your `context` port for a `ui://` document. Params that are not a string `uri`, or an unknown URI, are `-32602`. |
| Audit | Both methods are audited with `method` and `resource` (the URI, clipped to 200 characters). |

A resource is readable by a principal who may call at least one tool that references it. A `scope: null` tool makes its resource readable by any authenticated principal. A denied read is 403 `insufficient_scope` naming the scope of the first referencing tool; with `hideToolsOutsideScope: true` it answers as an unknown URI instead. Listing `resources/*` in `publicMethods` does not make them anonymous: they still answer 401.

### CSP

`csp.connectDomains` (fetch, XHR, WebSocket) and `csp.resourceDomains` (scripts, styles, images, fonts) are checked at construction. An entry is an exact origin (`https://cdn.example.com`, `https://cdn.example.com:8443`) or one leading wildcard label over a host (`https://*.example.com`). `wss://` is allowed in `connectDomains` only. A bare `*`, a path, credentials, a quote, a space, a `;`, `'self'`, `data:` or any other scheme throws. `frameDomains` and `baseUriDomains` are never sent, which the spec reads as none. With no `csp` the host applies its restrictive default.

The `html` is a static string shared by every user. Put per-user data in tool results (`structuredContent`), never in the HTML.

## Tool results

`ToolResult.content` takes the standard blocks (text, image, audio, resource_link, embedded resource). `structuredContent` must be a plain object and `_meta` an object; anything else is replaced by an `isError` result. Keep a text block in `content`: a host without MCP Apps shows only that.

## Host compatibility and limits

- MCP Apps support varies by host. Whether a host renders the view is outside this project's control, and no real host (Claude, ChatGPT or other) is exercised by its automated tests. Smoke-test your own server in the host you target.
- Protocol versions `2024-11-05`, `2025-03-26` and `2025-06-18`, and `2026-07-28` behind its own header (see [reference.md](reference.md#2026-07-28-requests)). Any other `MCP-Protocol-Version` gets a 400. The 2026-07-28 path serves the same UI resources; its `_meta.ui` handling was not tested with a host.
- No per-client negotiation. The server is stateless, so every client sees `_meta.ui`; a host without MCP Apps ignores it and shows the text result.
- `visibility` is metadata the host enforces. The server cannot tell a model call from a call made by the view, so it never uses `visibility` for authorization: scopes, argument validation, `context` and audit apply to every `tools/call`.
- The library cannot enforce tenant isolation beyond building `context` per call from the authenticated principal. It keeps no per-user state or cache; isolating tenants in your data layer remains yours.
- The `html` is trusted developer input and is served as configured, at whatever size.

## Specification comparison

Compared with the MCP Apps extension specification dated 2026-01-26 (Stable; the file was read in full and the draft was not reviewed). "Server" means what a server does; the host rules (sandbox, CSP enforcement) are the host's.

| Spec point | Level in the spec | mcp-trellis |
|------------|-------------------|-------------|
| `ui://` URI and MIME type `text/html;profile=mcp-app` | MUST | Supported |
| UI content as `text` | MUST be text or blob | `text` only; `blob` is not served |
| Tool `_meta.ui.resourceUri` and `visibility` | resource MUST exist on the server | Supported; construction fails when a tool names an unregistered URI |
| Flat `_meta["ui/resourceUri"]` | deprecated | Not emitted, on purpose |
| Resource `_meta.ui.csp` `connectDomains` and `resourceDomains` | optional | Supported and validated at construction |
| `csp.frameDomains`, `csp.baseUriDomains`, `permissions`, `domain`, `prefersBorder` | optional; no level stated for a server to set them | Not supported. Omitted CSP keys mean none, so this fails closed. No host that was run failed without them |
| Check the client's `io.modelcontextprotocol/ui` capability before registering UI tools | SHOULD (and MAY register variants) | Not supported. The server is stateless and every client sees the same `tools/list`; a host without the extension ignores `_meta.ui` and shows the text result |
| Text fallback: tools return meaningful `content` | SHOULD (`content` MUST be meaningful) | Supported; keep a text block in every UI tool's result |
| UI-only resources may be omitted from `resources/list` | MAY | Not omitted: they are listed to principals who may call the tool |

No UI registration ergonomics were measured in this release, so none was changed.

## Interoperability results

No MCP Apps host was run for this release. `test/mcp/ui/host.test.ts` is a harness, not a host.

| Host | Result |
|------|--------|
| Reference host `basic-host` (ext-apps) | Not tested |
| Claude, ChatGPT, VS Code and other hosts | Not tested |
| MCP Inspector | Not tested |

Smoke-test your own server in the host you target before relying on a view.
