# Project desk: existing login → authenticated MCP → your projects

Local docs for the Project desk demo. The code lives in [`examples/project-desk`](../project-desk/).

It is a Node app with its own browser session and a read-only `list_my_projects` tool. Alice owns two projects; Bob owns a different one. All records are fictional. It shows how to plug in existing auth; it is not an identity provider.

For a one-secret setup, use [`signedTokenAuth`](../../README.md#the-30-second-example). Project desk keeps an opaque token store instead, to show refresh rotation and rejection of scope escalation.

## Run locally

Needs Node 20+. From the repository root:

```bash
npm ci
export DEMO_PASSWORD=project-desk-demo
export OAUTH_CODE_SECRET="$(openssl rand -hex 32)"
npm run demo
```

Open `http://127.0.0.1:8787` and sign in as Alice or Bob with `project-desk-demo`. `DEMO_PASSWORD` must be at least 12 characters.

`npm run demo` builds the package first, and the demo imports its public exports (`mcp-trellis`, `mcp-trellis/node`). Self-host from npm: [project-desk README](../project-desk/README.md). Worker deploy and Registry listing: [`PUBLISH.md`](../project-desk/PUBLISH.md).

## Connect a real client

1. Put the demo behind a trusted HTTPS endpoint and set `PUBLIC_ORIGIN` to that exact origin before restarting. The Node server binds to loopback, for a reverse proxy.
2. Add `https://YOUR-DEMO-HOST/mcp` as a connector in your client. The host must also route `/.well-known/*` and `/mcp/oauth/*` to this process.
3. Sign in as Alice and approve consent.
4. Ask: **“List my projects and their next milestones.”** Expect Customer
   portal and Billing migration, never Internal analytics.
5. Revoke/disconnect, reconnect with Bob and repeat.
6. Report the result in a client compatibility issue.

## Verify locally

```bash
npm run build
npx tsx --test test/e2e/saas-demo.test.ts
```
