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

Publishes to npm from GitHub Actions using an **environment secret**
(`NPM_TOKEN`). The `npm-publish` environment is gated so only you approve.

### One-time setup (GitHub)

1. Create an npm [Granular Access Token](https://www.npmjs.com/settings/~/tokens)
   with **Read and write** on packages.
2. Repo → **Settings** → **Environments** → **New environment** → `npm-publish`
3. On that environment:
   - **Required reviewers** → add yourself (and only yourself)
   - **Environment secrets** → `NPM_TOKEN` = the npm token
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
