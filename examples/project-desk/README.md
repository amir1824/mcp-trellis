# Project desk — reference MCP server (mcp-trellis)

**Built with [mcp-trellis](https://www.npmjs.com/package/mcp-trellis).** This is a
fictional SaaS demo (Alice / Bob + projects), not a production identity
provider. The Official MCP Registry lists this **reference remote server** —
not the SDK package itself.

| | |
|---|---|
| Registry name | `io.github.amir1824/project-desk` |
| npm (self-host) | `mcp-trellis-project-desk` |
| Transport | Streamable HTTP (`/mcp`) + OAuth |
| SDK | [mcp-trellis](https://www.npmjs.com/package/mcp-trellis) |

## Hosted demo (Registry remotes)

After deploy (see [PUBLISH.md](PUBLISH.md)):

- MCP URL: `https://mcp-trellis-project-desk.<workers-subdomain>.workers.dev/mcp`
- Demo accounts: **alice** or **bob**
- Demo password (public, fictional data only): **`project-desk-demo`**

Connect a remote MCP client to that URL, sign in, approve consent, then ask to
list your projects. Alice sees Customer portal + Billing migration; Bob sees
Internal analytics.

## Self-host (Node)

From npm (after publish — see [PUBLISH.md](PUBLISH.md)):

```bash
npm install -g mcp-trellis-project-desk   # or npx
export DEMO_PASSWORD=project-desk-demo
export OAUTH_CODE_SECRET="$(openssl rand -hex 32)"
# Optional HTTPS reverse-proxy origin:
# export PUBLIC_ORIGIN=https://your-host.example
mcp-trellis-project-desk
```

Open `http://127.0.0.1:8787`. Put the process behind trusted HTTPS and set
`PUBLIC_ORIGIN` to that exact origin before connecting a real client.

npm metadata for the companion package lives in [`package.npm.json`](package.npm.json)
(not a nested `package.json`, so the monorepo can still self-import `mcp-trellis`).

## From this repo

```bash
npm ci
npm run build
export DEMO_PASSWORD=project-desk-demo
export OAUTH_CODE_SECRET="$(openssl rand -hex 32)"
npm run demo
```

E2E: `npx tsx --test test/e2e/saas-demo.test.ts`

## What this proves

App login → OAuth consent → access token → `list_my_projects` scoped to the
token owner. mcp-trellis supplies discovery, registration, PKCE, consent, code
exchange and authenticated tool dispatch. Your real product keeps its own
session, token store and data permissions.

In-memory maps only — restarting clears sessions and tokens. Do not copy this
login into production.
