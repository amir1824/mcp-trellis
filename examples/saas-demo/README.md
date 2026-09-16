# Project desk: existing login → authenticated MCP → your projects

**Canonical example** for mcp-trellis. A runnable Node app with an independent browser session and a read-only `list_my_projects` tool. Alice owns two projects; Bob owns a different project. All records are fictional. This is a demonstration of integrating existing auth, not a production identity provider or a real customer integration.

For a simpler one-secret setup without refresh tokens, use [`signedTokenAuth`](../../README.md#the-30-second-example) from the package root. This demo keeps an opaque token store so it can show refresh rotation and scope escalation rejection.

## README demo media

The README Demo still lives at [`docs/diagrams/demo-tool-result.png`](../../docs/diagrams/demo-tool-result.png) (tracked; ships in the npm docs diagram set). To replace it with a short GIF after recording:

1. `npm run demo` with `DEMO_PASSWORD` / `OAUTH_CODE_SECRET` set (see below).
2. Screen-record ~8–15s: Alice login → projects list. No secrets or token panels.
3. Export as GIF, save as `docs/diagrams/demo-tool-result.gif`, and point the README image at it.

## Run locally

Node 20+ and npm are required. From the repository root:

```bash
npm ci
export DEMO_PASSWORD="$(openssl rand -hex 16)"
export OAUTH_CODE_SECRET="$(openssl rand -hex 32)"
npm run demo
```

Open `http://127.0.0.1:8787`. The password is the value of `DEMO_PASSWORD` in your terminal; use `printenv DEMO_PASSWORD` privately to retrieve it. Do not include it in a recording. Sign in as Alice and inspect her projects. Switch to Bob to see a different record.

The demo imports the package's public exports (`mcp-trellis` and `mcp-trellis/node`), built locally by `npm run demo`. To copy it to a separate app, copy `app.ts`, `server.ts`, and `tokens.ts`, plus `examples/stores.ts` (for `isScopeSubset`), install `mcp-trellis` plus development dependencies `tsx`, `typescript`, `@types/node`, set `"type": "module"`, and run `npx tsx server.ts`. Registry installation is a separate release check; local self-import does not prove the published package is identical.

## Connect a real client

1. Put this fictional-data demo behind a trusted HTTPS endpoint. Set `PUBLIC_ORIGIN` to that exact external origin before restarting. The server binds to loopback for a local reverse proxy.
2. Configure your remote client with `https://YOUR-DEMO-HOST/mcp`. The host must also route `/.well-known/*` and `/mcp/oauth/*` to this process. Do not expose only `/mcp`.
3. Follow the client login flow, sign in as Alice and approve consent. Configure an exact callback URI via `extraRedirectUris` if the client callback is not in the built-in profile. Do not disable registration checks or use wildcard callbacks.
4. Ask: **“List my projects and their next milestones.”** Expect Customer portal and Billing migration, never Internal analytics.
5. Revoke/disconnect the connector in the client, reconnect with Bob and repeat. Merely switching the browser session does not change an already-issued token's user.
6. Record the client product/version/date, endpoint, negotiated protocol and sanitized output in [compatibility.md](../../docs/compatibility.md).

This client walkthrough is a checklist awaiting execution, not a claim of live compatibility. See [troubleshooting](../../docs/troubleshooting.md).

## What belongs to the app?

`session()` resolves an opaque browser session. `userProjects()` applies the owner filter. Tokens are random opaque values stored on the server, expire after one hour and carry the MCP audience. Access tokens are paired with refresh tokens; `refreshAccessToken` enforces audience + client id and rejects any requested `scope` outside the originally granted set (default grant is `mcp`; `admin` is advertised but not granted unless requested at authorize). No token is created from caller-supplied user IDs. mcp-trellis supplies discovery, registration, PKCE, consent, code exchange and authenticated tool dispatch.

For clarity, this sample uses one environment-provided password for two fictional accounts and in-memory maps. Restarting clears sessions and tokens. It has no durable storage, login rate limiting or production account management. Use your existing session/token services and shared replay store when deploying a real app; do not copy this sample login into production.

## Verify locally

```bash
npm run build
npx tsx --test test/e2e/saas-demo.test.ts
```

The tests execute login, registration, consent, PKCE, token exchange and a user-scoped tool call, then check isolation and invalid credentials. They emulate an OAuth client and do not launch Claude or ChatGPT.
