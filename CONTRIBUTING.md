# Contributing

Thanks for helping improve mcp-trellis. This guide covers local setup, PR expectations, and how maintainers release.

## Prerequisites

- Node.js **≥ 20**
- npm (comes with Node)

## Setup

```bash
git clone https://github.com/amir1824/mcp-trellis.git
cd mcp-trellis
npm ci
```

Verify:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Pull requests

1. Branch from `main`.
2. Keep the change focused — one concern per PR.
3. Add or update tests under `test/oauth/`, `test/mcp/`, `test/adapters/`, or `test/auth/` (unit) or `test/e2e/` (real-socket) when behavior changes.
4. Ensure CI is green: typecheck, test, test:e2e, and build must pass.

## Scope rules

- **Zero runtime dependencies.** Prefer Web standards (`Request` / `Response`, WebCrypto) and the Node built-ins already in use.
- Keep true fail-fast guards (`if (!principal)`, `if (!record)`, …) as early returns.
- Do not drive-by refactor unrelated files.
- Match existing naming and file layout under `src/`.

## Tests

Unit tests are grouped by topic:

| Path | Area |
|------|------|
| `mcp/app.test.ts` | `createMcpApp` end-to-end, incl. audience enforcement |
| `mcp/audit.test.ts` | Audit port, tool-error redaction |
| `mcp/dispatch.test.ts` | MCP HTTP dispatch |
| `mcp/protocol.test.ts` | Protocol version negotiation |
| `mcp/validate.test.ts` | JSON Schema subset |
| `mcp/tools.test.ts` | `defineTool` / `apiTool` |
| `mcp/body.test.ts` | Request body size limits |
| `auth/bearer.test.ts` | Bearer / timing-safe compare |
| `adapters/node.test.ts` | Node adapter |
| `adapters/origins.test.ts` | Origin allowlist (multi-tenant Host checks) |
| `oauth/*.test.ts` | OAuth AS pieces (`clients`, `consent`, `token`, …) |

`test/helpers/` is shared harness (not matched by the test glob). `test/e2e/` is a separate tier: it spawns [`examples/http-server.ts`](examples/http-server.ts) (`http.createServer` + `asNodeHandler`) and `fetch`es over loopback (header casing, streamed bodies, real redirects). It is not part of `npm test`.

Run with:

```bash
npm test
npm run test:e2e
```

## Releasing (maintainers)

Publishes to npm from GitHub Actions via **trusted publishing (OIDC)** —
no long-lived `NPM_TOKEN`. Provenance is attached automatically when the
trusted publisher is configured.

> **Status note (1.0.0):** the live `1.0.0` on npm was published manually
> from a local machine while the OIDC path above was still being debugged
> (see the `fix:`-prefixed commits around `2026-08-21`) — it does **not**
> carry npm provenance (`npm view mcp-trellis@1.0.0 dist.attestations` is
> empty). `publishConfig.provenance` was removed from `package.json` for
> exactly this reason: it blocked the local escape-hatch publish that got
> `1.0.0` out. The Actions workflow below still passes `--provenance`
> explicitly and remains the intended path — confirm the trusted-publisher
> config below is actually correct, then cut the **next** release
> (`1.0.1`+) through Actions so the npm page shows the Provenance badge.
> Don't publish locally again once that's confirmed working.

### One-time setup (required — publish fails with ENEEDAUTH until this exists)

1. Log in to npm as the package owner (`amir-b`).
2. Open [mcp-trellis → Settings → Trusted Publisher](https://www.npmjs.com/package/mcp-trellis/access)
   (or Package Settings → Trusted publishing).
3. Choose **GitHub Actions** and save exactly:

   | Field | Value |
   |-------|-------|
   | Organization or user | `amir1824` |
   | Repository | `mcp-trellis` |
   | Workflow filename | `publish.yml` (filename only — not `Release`, not a path) |
   | Environment name | leave **blank** |
   | Allowed actions | `npm publish` (check the box) |

   npm does **not** validate this form on save. Typos only show up as
   `ENEEDAUTH` / 404 when Actions runs.

4. Optional: GitHub → Settings → Tags → restrict who can create `v*` tags.

### Each release

1. Bump `"version"` in `package.json` and commit (`chore: release vX.Y.Z`).
2. Push `main`, then either:

   **A — tag (recommended)**
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   **B — button**
   Actions → **Release** → **Run workflow**.

If publish fails with `ENEEDAUTH` or a 404 on `PUT …/mcp-trellis`, the
trusted-publisher row above is missing or mistyped — fix it on npmjs.com and
re-run. Do not add a long-lived `NPM_TOKEN`.

`prepublishOnly` still runs build + test inside `npm publish` as a last guard.

### 0.2.0 note

`validateArgs: true` now throws at `createToolRegistry` construction when
`inputSchema` uses unsupported JSON Schema keywords. Pure metadata
(`description`, `title`, `$schema`, `$id`, `$comment`, `default`, `examples`,
`deprecated`, `readOnly`, `writeOnly`, `format`) is allowed. Semantically-
enforcing keywords that generators often emit — especially
`additionalProperties`, plus `pattern`, `minLength` / `maxLength`, `anyOf`,
`$ref`, … — will break upgrades until you remove them, enforce them in the
handler, or turn `validateArgs` off. Default (`validateArgs` off) is unchanged.
