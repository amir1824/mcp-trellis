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
no long-lived `NPM_TOKEN`. The `npm-publish` environment is gated so only
you approve the deployment. Provenance is attached automatically
(`npm publish --provenance`).

### One-time setup

1. On [npmjs.com](https://www.npmjs.com/) → package `mcp-trellis` →
   **Trusted Publisher** → configure GitHub Actions:
   - Repository: `amir1824/mcp-trellis`
   - Workflow filename: `publish.yml`
2. Repo → **Settings** → **Environments** → **New environment** → `npm-publish`
3. On that environment: **Required reviewers** → add yourself (and only yourself).
   Do **not** add an `NPM_TOKEN` secret — OIDC replaces it.
4. Optional hardening: **Settings** → **Tags** → restrict who can create `v*`
   tags to yourself.

### Each release

1. Bump `"version"` in `package.json` and commit (`chore: release vX.Y.Z`).
2. Push `main`, then either:

   **A — tag (recommended)**
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

   **B — button**
   Actions → **Release** → **Run workflow** (publishes the version currently
   in `package.json` on the branch you pick).

3. GitHub asks you to **Approve** the `npm-publish` deployment — only then
   does it publish to npm and create the GitHub Release.

If publish fails with `ENEEDAUTH`, the trusted-publisher config on npmjs.com
was never finished — fix that first. Do not fall back to a long-lived token.

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
