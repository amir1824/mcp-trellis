# mcp-trellis

[![CI](https://github.com/amir1824/mcp-trellis/actions/workflows/ci.yml/badge.svg)](https://github.com/amir1824/mcp-trellis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Zero-dependency **MCP JSON-RPC server** + **OAuth 2.1 authorization server** for Claude and Gemini remote connectors.

Web-standard `Request` → `Response`. Runs on Cloudflare Workers, Next.js App Router, Deno, Bun, and any Node HTTP `(req, res)` host via `mcp-trellis/node`.

## Requirements

- **Node ≥ 20** for Node hosts (global WebCrypto in ESM)
- Or any runtime with WebCrypto + `fetch` (Workers, Deno, Bun)

## Install

```bash
npm install mcp-trellis
```

## 60-second server

Smallest thing that answers MCP — no OAuth yet:

```ts
import { createMcpHandler, createToolRegistry } from "mcp-trellis";

const handler = createMcpHandler({
  registry: createToolRegistry([
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      handler: (_ctx, args) => String(args.text ?? ""),
    },
  ]),
  serverInfo: { name: "demo", version: "1.0.0" },
  wwwAuthenticate: {
    realm: "demo",
    resourceMetadataUrl:
      "https://demo.test/.well-known/oauth-protected-resource/mcp",
  },
  ports: {
    authenticate: async () => ({ id: "dev", scopes: ["*"] }),
    context: async () => ({}),
  },
});

// Wire handler.fetch into your edge / Node adapter
export default { fetch: (req: Request) => handler.fetch(req) };
```

Smoke-test with `initialize` (public — no Bearer needed):

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}'
```

## How it fits together

You wire two pieces. Your edge decides who handles each request:

![Architecture: connector → edge → OAuth or MCP → your ports](docs/diagrams/architecture.svg)

Typical first-connection path:

![Sequence: OAuth authorize and token, then MCP tool call](docs/diagrams/first-connection.svg)

## Why use it

- **One mental model** — you implement ports (auth, mint token, build context); the library owns protocol and OAuth plumbing
- **Honest metadata** — `grant_types_supported` only lists grants you actually wired
- **Host-agnostic** — Workers, Next.js, Express, Cloud Functions, Cloud Run
- **Zero runtime deps** — WebCrypto + fetch APIs only

## Package surface

| Import | What you get |
|--------|----------------|
| `mcp-trellis` | MCP handler, tool registry, bearer helpers, HTTP utils |
| `mcp-trellis/oauth` | OAuth 2.1 AS router, PKCE, auth codes, metadata |
| `mcp-trellis/node` | `asNodeHandler` + `resolveOrigin` for Node `(req, res)` |

### Default OAuth routes

With defaults `resourcePath: "/mcp"` and `oauthPath: "/mcp/oauth"`:

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-protected-resource` (+ `/mcp`) | Protected resource metadata |
| `/.well-known/oauth-authorization-server` (+ `/mcp`) | Authorization server metadata |
| `/mcp/oauth/register` | Dynamic client registration |
| `/mcp/oauth/authorize` | Authorization endpoint |
| `/mcp/oauth/token` | Token endpoint |

## Recipes

### Cloudflare Worker

Build the OAuth router from env bindings inside `fetch`:

```ts
import { createMcpHandler, createToolRegistry, parseBearer } from "mcp-trellis";
import { createOAuthRouter } from "mcp-trellis/oauth";

type Ctx = { userId: string };
type Env = { OAUTH_CODE_SECRET: string };

const registry = createToolRegistry<Ctx>([
  {
    name: "ping_db",
    description: "Health check",
    inputSchema: { type: "object", properties: {} },
    scope: "read",
    handler: async () => "ok",
  },
]);

const handler = createMcpHandler<Ctx>({
  registry,
  serverInfo: { name: "my-app", version: "1.0.0" },
  instructions: "Tools available to authenticated clients.",
  wwwAuthenticate: (req) => ({
    realm: "my-app",
    resourceMetadataUrl: `${new URL(req.url).origin}/.well-known/oauth-protected-resource/mcp`,
  }),
  ports: {
    authenticate: async (req) => {
      const token = parseBearer(req.headers.get("authorization"));
      if (!token) return null;
      return { id: "user-1", scopes: ["read"] };
    },
    context: async (_req, principal) => ({
      userId: principal?.id ?? "",
    }),
  },
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const oauth = createOAuthRouter({
      ports: {
        codeSecret: env.OAUTH_CODE_SECRET,
        resolveUser: async () => ({ id: "user-1" }),
        loginUrl: (req, next) =>
          `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
        mintAccessToken: async ({ userId }) => ({
          accessToken: await issueUserToken(userId),
          expiresIn: 31_536_000,
          scope: "mcp",
        }),
      },
    });

    const oauthResponse = await oauth.tryHandle(request);
    if (oauthResponse) return oauthResponse;
    if (new URL(request.url).pathname === "/mcp") return handler.fetch(request);
    return new Response("Not found", { status: 404 });
  },
};
```

### Next.js App Router

Delegate Web `Request` straight through — same handler as above:

```ts
// app/mcp/route.ts
import { handler, oauth } from "@/lib/mcp"; // your shared setup

export async function GET(req: Request) {
  const oauthResponse = await oauth.tryHandle(req);
  if (oauthResponse) return oauthResponse;
  return handler.fetch(req);
}

export async function POST(req: Request) {
  const oauthResponse = await oauth.tryHandle(req);
  if (oauthResponse) return oauthResponse;
  return handler.fetch(req);
}

export async function OPTIONS() {
  return handler.fetch(new Request("https://local/mcp", { method: "OPTIONS" }));
}
```

Also mount `.well-known/*` and `/mcp/oauth/*` the same way (or route everything through one catch-all that calls `oauth.tryHandle` first).

### Node HTTP `(req, res)`

Express, Cloud Functions, Cloud Run, `http.createServer` — bridge with `asNodeHandler`:

```ts
import { createMcpHandler } from "mcp-trellis";
import { asNodeHandler } from "mcp-trellis/node";

const handler = createMcpHandler({ /* same ports as above */ });

export const mcp = asNodeHandler(handler, {
  origin: process.env.MCP_PUBLIC_ORIGIN!, // required unless trustProxy
  // trustProxy: true, // only behind a known reverse proxy
});
```

## Ports — what you implement

The library stays protocol-shaped. Your app plugs in the seams:

![Ports: library calls into your authenticate, context, resolveUser, mintAccessToken](docs/diagrams/ports.svg)

### MCP (`createMcpHandler`)

| Port | Role |
|------|------|
| `authenticate(req, method, tool?)` | Return `{ id, scopes }`, or `null` → 401 + `WWW-Authenticate` |
| `context(req, principal)` | Build per-request ctx for tools (DB, env, …) |
| `audit?(entry)` | Optional tool-call telemetry |

`wwwAuthenticate` can be a static object or `(req) => …` when the PRM URL depends on origin.

By default `initialize`, `ping`, and notifications are public. Override `publicMethods` if every method must require Bearer.

### OAuth (`createOAuthRouter`)

| Port | Role |
|------|------|
| `codeSecret` | HMAC secret for signed auth codes (string or `(req) => string`) |
| `resolveUser` | Consenting user, or `null` → redirect to `loginUrl` |
| `loginUrl` | Where unauthenticated authorize requests go |
| `mintAccessToken` | Issue a **user-bound** access token — never a shared god token |
| `refreshAccessToken?` | If set, metadata advertises `refresh_token` |
| `codeStore?` | Shared single-use jti store for multi-instance (`consume(jti, expMs)`); pruning in-memory default otherwise |

Auth codes always carry `userId`. Advertised grants come only from the handlers you configure.

## Tool registry

Schema and handler live in one place — no parallel “defs” and “handlers” lists to keep in sync:

```ts
createToolRegistry(tools, { validateArgs: false }) // default: off, easy adoption
```

- Handler may return a `string` or `{ content, isError? }`
- Unknown tools and thrown errors become `isError: true` (not transport errors)
- Duplicate tool names throw at registry construction
- Turn `validateArgs: true` once clients send schema-valid args

## Reference

### Supported MCP methods

| Method | Auth | Notes |
|--------|------|-------|
| `initialize` | public | Negotiates protocol version; returns `capabilities.tools` |
| `ping` | public | Empty result |
| `tools/list` | Bearer | Lists registry entries |
| `tools/call` | Bearer + scope | Runs the tool; missing scope → 401 |
| `notifications/*` | public | HTTP 202 empty body |

Anything else → JSON-RPC `-32601`. Capabilities advertise **tools only**.

### HTTP and JSON-RPC status codes

| HTTP | When |
|------|------|
| **202** | Notification (empty body) |
| **400** | Parse error, batch array, invalid request |
| **401** | Missing/invalid Bearer; includes `WWW-Authenticate` |
| **405** | Wrong HTTP verb on MCP |

| JSON-RPC code | Constant |
|---------------|----------|
| `-32700` | `JSONRPC_PARSE_ERROR` |
| `-32600` | `JSONRPC_INVALID_REQUEST` (batches) |
| `-32601` | `JSONRPC_METHOD_NOT_FOUND` |
| `-32602` | `JSONRPC_INVALID_PARAMS` |
| `-32603` | `JSONRPC_INTERNAL_ERROR` |
| `-32001` | `JSONRPC_UNAUTHORIZED` |

### `createMcpHandler` options

| Option | Required | Description |
|--------|----------|-------------|
| `registry` | yes | From `createToolRegistry` |
| `ports` | yes | `authenticate`, `context`, optional `audit` |
| `serverInfo` | yes | `{ name, version }` |
| `wwwAuthenticate` | yes | Static or `(req) => …` for RFC 9728 PRM URL |
| `instructions` | no | Returned on `initialize` |
| `publicMethods` | no | Default: `initialize`, `ping`, notifications |

### `createOAuthRouter` options

| Option | Default | Description |
|--------|---------|-------------|
| `ports` | — | Required OAuth ports (see above) |
| `resourcePath` | `"/mcp"` | MCP resource path in PRM |
| `oauthPath` | `"/mcp/oauth"` | Prefix for authorize / token / register |
| `realm` | — | Optional realm string |
| `scopes` | `["mcp"]` | Advertised in metadata |
| `redirect` | see below | Redirect URI allowlist |

**`redirect` (`RedirectAllowlistOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `extra` | `[]` | Exact-match redirect URIs |
| `allowLoopback` | `true` | Allow `http(s)://127.0.0.1` and `localhost` |
| `allowClaude` | `true` | Allow the Claude.ai Custom Connector callback |

### Exports

<details>
<summary><code>mcp-trellis</code></summary>

- `createMcpHandler`, `createToolRegistry`
- `parseBearer`, `timingSafeEqual`, `matchesAny`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`
- `rpcResult`, `rpcError`, JSON-RPC error constants
- `pickProtocolVersion`, `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`
- `jsonResponse`, `emptyResponse`, `optionsResponse`, `corsHeaders`, `methodNotAllowed`
- Types: `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolResult`, `ToolRegistry`, `JsonSchema`, …

</details>

<details>
<summary><code>mcp-trellis/oauth</code></summary>

- `createOAuthRouter`
- `authorizationServerMetadata`, `protectedResourceMetadata`, `mcpWwwAuthenticate`
- `isAllowedRedirectUri`, `CLAUDE_CALLBACK`
- `issueAuthCode`, `consumeAuthCode`, `newClientId`
- `verifyPkceS256`, `sha256Base64Url`, `randomBase64Url`
- `GRANT_TYPES`, `OAUTH_ERRORS`, `DEFAULT_SCOPE`
- Types: `OAuthUser`, `MintedToken`, `OAuthPorts`, `OAuthRouterOptions`, `AuthCodeRecord`, `CodeStore`

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `toWebRequest`, `sendWebResponse`
- Types: `NodeRequestLike`, `NodeResponseLike`, `AsNodeHandlerOptions`

</details>

## Protocol promises

- Notifications → HTTP **202** with an empty body
- Batch arrays → `-32600` (MCP 2025-06-18)
- Protocol version negotiated from client `initialize` params
- Query-string tokens rejected
- `tools/call` checks `principal.scopes` (`*` = all)

## Security model and known limits

**Designed in**

- PKCE **S256** mandatory — `plain` is rejected; challenge compare is timing-safe and length-capped
- Auth codes are HMAC-SHA256 signed and bind `userId`, `clientId`, `redirectUri`, and the challenge
- Auth codes are **single-use** by default (pruning in-memory jti map). Multi-instance deploys must pass a shared `codeStore` (KV / Redis `SET NX EX`)
- `mintAccessToken` always receives the consenting `userId` — mint user-bound tokens, never a shared god token
- Redirect URIs limited to the Claude callback, loopback hosts, and your `extra` list; DCR rejects when all supplied URIs fail the allowlist
- Tokens in query strings are rejected on both GET and POST
- Metadata only advertises grants you actually implemented
- OAuth `/token` responses, errors, OPTIONS, and 405 omit `Access-Control-Allow-Origin: *`
- `asNodeHandler` **requires** `origin` unless `trustProxy: true` (then uses the last `X-Forwarded-*` hop)

**App responsibilities**

- Your login page must validate the `next` path is same-origin before redirecting after login
- Pass an explicit `origin`, or only enable `trustProxy` behind a proxy that strips client-supplied forwarded headers

**Known limits**

- In-memory single-use is **process-local** — not shared across Workers isolates / replicas without `codeStore`
- Loopback allowlist permits any path/port on `localhost` / `127.0.0.1` — expected for native clients

## Not in scope

- `resources/*` and `prompts/*` — tools only
- Streaming / SSE transports
- stdio transport
- Batch JSON-RPC requests
- Token storage, sessions, or login UI (you own those ports)

## Scripts

```bash
npm test
npm run build
npm run typecheck
```

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
