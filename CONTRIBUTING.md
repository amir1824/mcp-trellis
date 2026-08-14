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
3. Add or update tests under `test/*.test.ts` (unit) or `test/e2e/` (real-socket) when behavior changes.
4. Ensure CI is green: typecheck, test, test:e2e, and build must pass.

## Scope rules

- **Zero runtime dependencies.** Prefer Web standards (`Request` / `Response`, WebCrypto) and the Node built-ins already in use.
- Keep true fail-fast guards (`if (!principal)`, `if (!record)`, …) as early returns.
- Do not drive-by refactor unrelated files.
- Match existing naming and file layout under `src/`.

## Tests

Unit tests live flat under `test/`:

| File | Area |
|------|------|
| `app.test.ts` | `createMcpApp` end-to-end, incl. audience enforcement |
| `audit.test.ts` | Audit port, tool-error redaction |
| `auth.bearer.test.ts` | Bearer / timing-safe compare |
| `dispatch.test.ts` | MCP HTTP dispatch |
| `oauth.clients.test.ts` | Client profiles, confidential clients |
| `oauth.*.test.ts` | OAuth AS pieces |
| `protocol.test.ts` | Protocol version negotiation |
| `validate.test.ts` | JSON Schema subset |
| `node.test.ts` | Node adapter |
| `tools.test.ts` | `defineTool` / `apiTool` |

`test/e2e/` is a separate tier: it spawns [`examples/http-server.ts`](examples/http-server.ts) (`http.createServer` + `asNodeHandler`) and `fetch`es over loopback (header casing, streamed bodies, real redirects). It is not part of `npm test`.

Run with:

```bash
npm test
npm run test:e2e
```

## Releasing (maintainers)

Releases publish to npm from GitHub Actions via **Trusted Publishing**
(OIDC) — no long-lived npm token in secrets, no local OTP.

### One-time setup

1. Publish `0.1.0` once from your machine (granular access token), so the
   package exists on npm:
   ```bash
   npm publish --access public
   ```
2. On [npmjs.com/package/mcp-trellis](https://www.npmjs.com/package/mcp-trellis)
   → **Settings** → **Trusted Publisher** → GitHub Actions:
   - Organization or user: `amir1824`
   - Repository: `mcp-trellis`
   - Workflow filename: `publish.yml` (filename only)
   - Allowed action: `npm publish`
3. Push this workflow to `main` if it is not there yet.

### Each release

1. Bump `"version"` in `package.json`.
2. Commit: `chore: release vX.Y.Z`.
3. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main
   git push origin vX.Y.Z
   ```
4. The [Release](.github/workflows/publish.yml) workflow checks that the tag
   matches `package.json`, runs typecheck / unit / e2e / build, publishes to
   npm, and creates a GitHub Release.

`prepublishOnly` still runs build + test inside `npm publish` as a last guard.
