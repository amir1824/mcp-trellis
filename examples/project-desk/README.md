# Project desk — reference MCP server (mcp-trellis)

A fictional SaaS demo (Alice, Bob and their projects) built with [mcp-trellis](https://www.npmjs.com/package/mcp-trellis). It is not an identity provider. The Official MCP Registry entry is for this reference server, not for the SDK.

| | |
|---|---|
| Registry name | `io.github.amir1824/project-desk` |
| npm (self-host) | `mcp-trellis-project-desk` |
| Transport | Streamable HTTP (`/mcp`) + OAuth |

## Hosted demo (Registry remotes)

After deploy (see [PUBLISH.md](PUBLISH.md)):

- MCP URL: `https://mcp-trellis-project-desk.<workers-subdomain>.workers.dev/mcp`
- Demo accounts: **alice** or **bob**
- Demo password (public, fictional data only): **`project-desk-demo`**

Add that URL as a connector, sign in, approve consent, then ask for your projects. Alice sees Customer portal and Billing migration; Bob sees Internal analytics.

## Self-host (Node)

From npm (see [PUBLISH.md](PUBLISH.md)):

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

The npm metadata is in [`package.npm.json`](package.npm.json), not a nested `package.json`, so this repo can still import `mcp-trellis`.

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

App login, OAuth consent, access token, then `list_my_projects` scoped to the token owner. mcp-trellis supplies discovery, registration, PKCE, consent, code exchange and tool dispatch. Your product keeps its own session, token store and data permissions.

Sessions and tokens live in memory and are lost on restart. Do not copy this login into production.
