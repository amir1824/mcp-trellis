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
3. Add or update tests under `test/oauth/`, `test/mcp/`, `test/adapters/`, `test/auth/`, or `test/util/` (unit) or `test/e2e/` (real-socket) when behavior changes.
4. Ensure CI is green: typecheck, test, test:e2e, and build must pass.

## Scope rules

- **Zero runtime dependencies.** Prefer Web standards (`Request` / `Response`, WebCrypto) and the Node built-ins already in use.
- Keep true fail-fast guards (`if (!principal)`, `if (!record)`, …) as early returns.
- Do not drive-by refactor unrelated files.
- Match existing naming and file layout under `src/`.
- At most three parameters per function; group related values into one object (`ClientAuthContext`, `Callback`) rather than threading them separately. Public signatures are the only exception.
- Reuse the shared building blocks instead of redeclaring them: `util/json.ts` (`isJsonObject`), `util/defined.ts` (`pickDefined`), `http/http.ts` (`GET_ONLY`, `POST_ONLY`, `NO_CORS`, `DEFAULT_AUDIT_TIMEOUT_MS`), `oauth/crypto/hkdf.ts` (every key derived from `codeSecret`).
- Shared types live in `oauth/types.ts` / `cimd/types.ts`; a types module must not import from an endpoint module.

## Code comments

- Comment the **why**: a security invariant, an RFC requirement, a non-obvious trade-off. Do not restate what the code already says.
- Do not narrate history ("previously…", "since 1.x we…"). That belongs in `CHANGELOG.md` and commit messages. Public JSDoc may still say when a default changed (`Default **true** since 2.0`), because users need it.
- `ponytail:` marks a known, deliberate limitation together with its upgrade path, e.g. `ponytail: single-process only; multi-instance → pass ports.codeStore`. Keep the marker when you touch that code; remove it once the limitation is gone.

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
| `mcp/readme-quickstart.test.ts` | README 30-second example runs as written |
| `auth/bearer.test.ts` | Bearer / timing-safe compare |
| `adapters/node.test.ts` | Node adapter |
| `adapters/origins.test.ts` | Origin allowlist (multi-tenant Host checks) |
| `oauth/*.test.ts` | OAuth AS pieces (`clients`, `consent`, `token`, …) |
| `util/*.test.ts` | Internal helpers |

`test/helpers/` and `test/fixtures/` are shared harness (not matched by the test glob). `test/e2e/` is a separate tier: it spawns [`examples/http-server.ts`](examples/http-server.ts) (`http.createServer` + `asNodeHandler`) and `fetch`es over loopback (header casing, streamed bodies, real redirects). It is not part of `npm test`.

Run with:

```bash
npm test
npm run test:e2e
```

## Releasing (maintainers)

Publishes to npm from GitHub Actions via **trusted publishing (OIDC)** —
no long-lived `NPM_TOKEN`. `package.json` sets `publishConfig.provenance`
and the workflow also passes `--provenance`. From **2.0.0** onward this is
the only supported release path.

> **Historical note:** `1.0.0` was published manually without provenance
> while OIDC was being debugged. Do **not** repeat that for 2.x — if Actions
> fails with `ENEEDAUTH`, fix the trusted-publisher row on npmjs.com and
> re-run. Local `npm publish` with a classic token is an emergency escape
> hatch only; it will not attach provenance and must not be used for a
> marketed release.

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

### 2.0.0 note

`validateArgs` defaults to **on**. Unsupported JSON Schema keywords throw at
`createToolRegistry` construction. Pure metadata (`description`, `title`,
`$schema`, `$id`, `$comment`, `default`, `examples`, `deprecated`,
`readOnly`, `writeOnly`, `format`) is allowed. Semantically-enforcing
keywords that generators often emit — especially `additionalProperties`,
plus `pattern`, `minLength` / `maxLength`, `anyOf`, `$ref`, … — will break
upgrades until you remove them, enforce them in the handler, or set
`validateArgs: false`.

`codeStore` is required at construction unless you set
`allowInMemoryCodeStore: true` (single-process / tests only).
