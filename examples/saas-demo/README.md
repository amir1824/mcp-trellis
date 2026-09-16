# Project desk: existing login → authenticated MCP → your projects

**Canonical local docs** for the Project desk demo. Implementation lives in
[`examples/project-desk`](../project-desk/) (also the Official MCP Registry
reference server and `mcp-trellis-project-desk` npm package).

A runnable Node app with an independent browser session and a read-only
`list_my_projects` tool. Alice owns two projects; Bob owns a different project.
All records are fictional. This demonstrates integrating existing auth — not a
production identity provider.

For a simpler one-secret setup without refresh tokens, use
[`signedTokenAuth`](../../README.md#the-30-second-example) from the package
root. Project desk keeps an opaque token store so it can show refresh rotation
and scope escalation rejection.

## README demo media

The README Demo still lives at
[`docs/diagrams/demo-tool-result.png`](../../docs/diagrams/demo-tool-result.png).
To replace it with a short GIF after recording:

1. `npm run demo` with `DEMO_PASSWORD` / `OAUTH_CODE_SECRET` set (see below).
2. Screen-record ~8–15s: Alice login → projects list. No secrets or token panels.
3. Export as GIF, save as `docs/diagrams/demo-tool-result.gif`, and point the
   README image at it.

## Run locally

Node 20+ and npm are required. From the repository root:

```bash
npm ci
export DEMO_PASSWORD=project-desk-demo
export OAUTH_CODE_SECRET="$(openssl rand -hex 32)"
npm run demo
```

Open `http://127.0.0.1:8787`. Sign in as Alice or Bob with password
`project-desk-demo`. For a one-off local password, set any ≥12 character
`DEMO_PASSWORD` instead.

The demo imports the package's public exports (`mcp-trellis` and
`mcp-trellis/node`), built locally by `npm run demo`. Self-host from npm:
[`mcp-trellis-project-desk`](../project-desk/README.md). Registry listing and
Worker deploy: [`PUBLISH.md`](../project-desk/PUBLISH.md).

## Connect a real client

1. Put this fictional-data demo behind a trusted HTTPS endpoint. Set
   `PUBLIC_ORIGIN` to that exact external origin before restarting. The Node
   server binds to loopback for a local reverse proxy.
2. Configure your remote client with `https://YOUR-DEMO-HOST/mcp`. The host must
   also route `/.well-known/*` and `/mcp/oauth/*` to this process.
3. Follow the client login flow, sign in as Alice and approve consent.
4. Ask: **“List my projects and their next milestones.”** Expect Customer
   portal and Billing migration, never Internal analytics.
5. Revoke/disconnect, reconnect with Bob and repeat.
6. Record evidence in [compatibility.md](../../docs/compatibility.md).

## Verify locally

```bash
npm run build
npx tsx --test test/e2e/saas-demo.test.ts
```
