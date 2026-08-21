# mcp-trellis

[![CI](https://github.com/amir1824/mcp-trellis/actions/workflows/ci.yml/badge.svg)](https://github.com/amir1824/mcp-trellis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Host-agnostic MCP + OAuth ports** — you bring the runtime and IdP; the library owns the connector protocol.

Web-standard `Request` → `Response`. Same handler on Cloudflare Workers, Next.js App Router, Deno, Bun, and Node HTTP via `mcp-trellis/node`. Zero runtime dependencies.

## Why mcp-trellis

The whole connector stack in one package — MCP handler **and** OAuth 2.1 authorization server — with no database and no vendor signup. You own login, token minting, and storage; the library owns the protocol.

| | mcp-trellis | Official MCP SDK | `workers-oauth-provider` | `@mcpauth/auth` | Auth0 / Clerk / Authlete |
|---|---|---|---|---|---|
| MCP handler | ✅ | ✅ | ❌ | ❌ | ❌ |
| OAuth 2.1 authorization server | ✅ | ❌ bring your own | ✅ | ✅ | ✅ |
| Runtime | any Web-standard | any Web-standard | Workers only | Node | — |
| Database | none | — | KV (optional) | **required** | — |
| Runtime dependencies | **zero** | several | several | several | — |
| Self-hosted | ✅ | ✅ | ✅ | ✅ | ❌ SaaS |
| Named connector profiles (Claude / Gemini / Codex), enforced | ✅ | ❌ | ❌ | ❌ | ❌ |

Prefer the official SDK when you already have a separate AS. Prefer
`workers-oauth-provider` when you want Cloudflare's Workers-only
implementation. Prefer a managed IdP when you'd rather pay than operate one.

Named alternatives in the same problem space:

- **`@mcpauth/auth` / `getmcpauth` / `mcp-auth`** — OAuth for MCP, typically
  with a DB or a different runtime/stack assumption. mcp-trellis is the
  **zero-dependency** option that ships the MCP handler **and** the OAuth 2.1
  AS in one package.
- **`fastmcp-oauth`** — OAuth helpers around FastMCP. mcp-trellis is host-agnostic
  (`Request`/`Response`) and not tied to a particular MCP framework.

## Requirements

- **Node ≥ 20** for Node hosts (global WebCrypto in ESM)
- Or any runtime with WebCrypto + `fetch` (Workers, Deno, Bun)

## Install

```bash
npm install mcp-trellis
```

## Quick start

One call mounts the MCP endpoint, the OAuth authorization server, and both discovery documents:

```ts
import { createMcpApp } from "mcp-trellis";

const app = createMcpApp({
  serverInfo: { name: "demo", version: "1.0.0" },
  clients: ["claude"],
  tools: [
    {
      name: "echo",
      description: "Echo text back",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      scope: "mcp",
      handler: (_ctx, args) => String(args.text ?? ""),
    },
  ],
  auth: {
    codeSecret: process.env.OAUTH_CODE_SECRET!,
    resolveUser: async (req) => getSession(req),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async ({ userId, scope, resource }) => ({
      // Embed `resource` as the token audience (RFC 8707).
      accessToken: await issueUserToken(userId, { aud: resource, scope }),
      expiresIn: 3600,
    }),
    verifyToken: async (token) => {
      const claims = await readUserToken(token);
      if (!claims) return null;
      return {
        userId: claims.sub,
        scopes: claims.scope.split(" "),
        audience: claims.aud,
      };
    },
  },
});

export default { fetch: (req: Request) => app.fetch(req) };
```

You return the token's `audience`; **the library rejects tokens minted for a different resource** before any tool runs. Details: [docs/security.md](docs/security.md).

A real `/authorize` walk includes an approval step: a resolved session doesn't redirect straight back with a code, it renders a consent screen first (built in, or your own via `consent`). First-time integrators clicking through by hand should expect an HTML page there, not an immediate redirect — see [Consent](docs/guide.md#consent).

Smoke-test with `initialize` (public — no Bearer needed):

```bash
curl -s http://127.0.0.1:8787/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"demo","version":"1.0.0"},"instructions":""}}
```

## Clients

| Client | Registration | Token endpoint auth | Notes |
|--------|--------------|---------------------|-------|
| `claude` | Dynamic (DCR), public + PKCE | `none` | Claude Custom Connectors callback allowlisted |
| `gemini` | **Pre-registered**, confidential | `client_secret_basic`, `client_secret_post` | Supply `auth.clientStore` |
| `codex` | OAuth 2.1 per MCP auth spec, public + PKCE | `none` | ChatGPT / Codex share one contract |

Pre-registered clients, DCR enforcement, and `clientStore` wiring: [docs/guide.md#clients](docs/guide.md#clients).

## Architecture

`createMcpApp` wires MCP and OAuth and routes between them:

![Architecture: connector → edge → OAuth or MCP → your ports](docs/diagrams/architecture.svg)

![Sequence: OAuth authorize and token, then MCP tool call](docs/diagrams/first-connection.svg)

Host recipes, ports, tools, and multi-tenant: [docs/guide.md](docs/guide.md).

## Docs

| Doc | Contents |
|-----|----------|
| [docs/guide.md](docs/guide.md) | Architecture, clients, recipes, ports, tools, multi-tenant |
| [docs/reference.md](docs/reference.md) | Routes, methods, status codes, options, exports |
| [docs/security.md](docs/security.md) | Protocol promises, threat model, not in scope |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What's next |

Examples: [`examples/`](examples/) — HTTP server, Worker, multi-tenant, stores, audit.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
npm test
npm run build
npm run typecheck
```

## License

MIT
