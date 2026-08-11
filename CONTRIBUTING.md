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
npm run build
```

## Pull requests

1. Branch from `main`.
2. Keep the change focused — one concern per PR.
3. Add or update tests under `test/*.test.ts` when behavior changes.
4. Ensure CI is green: typecheck, test, and build must pass.

## Scope rules

- **Zero runtime dependencies.** Prefer Web standards (`Request` / `Response`, WebCrypto) and the Node built-ins already in use.
- Keep true fail-fast guards (`if (!principal)`, `if (!record)`, …) as early returns.
- Do not drive-by refactor unrelated files.
- Match existing naming and file layout under `src/`.

## Tests

Tests live flat under `test/`:

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

Run with:

```bash
npm test
```

## Releasing (maintainers)

Publishing is **manual** for now (no npm token in CI).

1. Bump `"version"` in `package.json`.
2. Commit: `chore: release vX.Y.Z`.
3. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Publish: `npm publish` (from a clean tree after `npm run build`).

`prepublishOnly` already runs build + test before publish.
