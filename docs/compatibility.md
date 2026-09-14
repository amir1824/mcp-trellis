# Compatibility evidence

Updated 2026-09-14. Repository implementation and automated coverage are in good
shape after the pre-prod security pass. **Vendor-client UI sessions are still
Pending** — do not convert product rows to ✅ until a live Claude/ChatGPT/Codex/Gemini
check below is filled in.

| Product | Server profile | Repository evidence | Live evidence |
|---|---|---|---|
| Claude custom connector | `claude`: DCR / CIMD, public client, S256 PKCE; built-in callback | `test/oauth/clients.test.ts`, `dcr.test.ts`, `cimd.test.ts`, `pkce.test.ts`; saas-demo e2e + `scripts/prep-claude-oauth.mjs` | Pending (UI) |
| ChatGPT | `codex`: public-client profile; exact hosted callback must be configured | Profile tests only; no ChatGPT UI test | Pending |
| Codex | `codex`: public client, PKCE, loopback callbacks allowed | Profile/redirect tests; no actual Codex login run | Pending |
| Gemini Enterprise | `gemini`: `clientStore`, pre-registration, `client_secret_basic` / `client_secret_post` | Client authentication tests; no Enterprise environment | Pending |

The Gemini profile does not imply compatibility with Gemini CLI or every Gemini product. ChatGPT and Codex need separate live checks even though the package groups them under one profile.

`src/protocol.ts` implements `2024-11-05`, `2025-03-26`, `2025-06-18`. Initialization defaults to `2025-06-18`; absent request headers use `2025-03-26`. This is an implementation inventory, not a claim to implement the latest revision. **CIMD is shipped** (`src/oauth/cimd.ts`, advertised when enabled); newer protocol revisions remain separate work. Live vendor UI evidence stays **Pending** until an operator connects a real client.

## Demo deploy (Worker)

Compile-checked Worker sketch: [`examples/cloudflare-worker.ts`](../examples/cloudflare-worker.ts).

One-liner after you add a minimal `wrangler.toml` (name, `compatibility_date`, and secrets
`OAUTH_CODE_SECRET` / `ACCESS_TOKEN_SECRET`):

```bash
npx wrangler secret put OAUTH_CODE_SECRET
npx wrangler secret put ACCESS_TOKEN_SECRET
npx wrangler deploy examples/cloudflare-worker.ts
```

Point a connector at `https://YOUR-WORKER/mcp` only after secrets and an origin
allowlist match your route. This path proves the Worker mounts; it does **not**
replace the live client rows below.

## Host contract covered in-repo

`examples/saas-demo` now mints refresh tokens and enforces RFC 6749 §6: requested
refresh `scope` must be ⊆ the scopes originally bound to that refresh token
(`isScopeSubset` pattern also in `examples/stores.ts`). Escalation →
`invalid_grant`. Covered by `test/e2e/saas-demo.test.ts`.

## Automated package smoke (not a vendor live pass)

```bash
npm run smoke:pack
```

Installs the local `npm pack` tarball in a temp directory and imports
`createMcpApp` / `asNodeHandler`. Record date/commit when you run it before a
release; it does **not** replace the live client row.

| Date | Commit / package | Command | Result |
|---|---|---|---|
| 2026-09-12 | unreleased working tree (`1.1.0` pack) | `npm run smoke:pack` | Pass — `createMcpApp` + `asNodeHandler` import from tarball |

## Evidence required for a live pass

Record client product, version/build (or web UI and test date), account tier, package version/commit, hosting environment and configured callback. Capture discovery → registration → app login → consent → token exchange → initialize → tools/list → `list_my_projects`. Verify wrong audience/invalid token rejection and user isolation separately. Save sanitized output or recording; exclude cookies, passwords, codes and tokens.

Against a public HTTPS demo (`PUBLIC_ORIGIN` + `DEMO_PASSWORD`):

```bash
npm run demo   # reverse-proxy to HTTPS; set PUBLIC_ORIGIN
node scripts/prep-claude-oauth.mjs   # scripted OAuth + refresh scope + tool
# Then open the vendor UI with MCP URL https://YOUR-HOST/mcp and record below.
```

| Date | Client/build | Package/commit | Protocol negotiated | Tool + expected result | Evidence | Result |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | Pending |

## Under-ten-minute onboarding test

Use a clean folder and the published npm tarball, start a timer at `npm install`, and stop at a real client's first correct user-scoped tool response. Record setup prerequisites, elapsed time, every edit and any error. A local source import or simulated OAuth flow is insufficient. Target: under ten minutes with hosting and a supported client account available; no time claim is published until measured.

| Field | Value |
|---|---|
| Start (`npm install`) | — |
| Stop (first correct tool in real client) | — |
| Elapsed | — |
| Prerequisites (hosting, account, callback) | — |
| Edits / errors | — |
| Result | Pending |
