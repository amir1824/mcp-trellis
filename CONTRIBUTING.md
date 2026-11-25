# Contributing

Local setup, pull request rules and the release steps. Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

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
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Pull requests

1. Branch from `main`.
2. Keep the change focused: one concern per PR.
3. When behavior changes, add or update a test: unit tests under `test/` (grouped by area), real-socket tests under `test/e2e/`.
4. Update the docs and `CHANGELOG.md` for user-visible changes. A doc code block must match the real API; `npm run check:quickstart` runs the README example.
5. CI must be green: lint, typecheck, `check:limits`, `check:quickstart`, tests, `test:e2e` and build.

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
- Do not narrate history ("previously…"). That belongs in `CHANGELOG.md` and commit messages.
- `ponytail:` marks a known, deliberate limitation together with its upgrade path, e.g. `ponytail: single-process only; multi-instance → pass ports.codeStore`. Keep the marker when you touch that code; remove it once the limitation is gone.

## Tests

Tests live under `test/`, grouped by area: `oauth/`, `mcp/` (with `modern/`, `ui/`, `resources/`, `skills/`), `security/`, `adapters/`, `auth/`, `util/`. `test/helpers/` and `test/fixtures/` are shared harness. `npm test` runs them all.

`test/e2e/` is a separate tier, run by `npm run test:e2e`. It spawns [`examples/http-server.ts`](examples/http-server.ts) and calls it with `fetch` over loopback (header casing, streamed bodies, real redirects).

Some tests read the docs and fail when a doc and the code disagree (for example `test/mcp/readme-quickstart.test.ts` runs the README's 30-second example).

## Releasing (maintainers)

npm publishes from GitHub Actions with trusted publishing (OIDC) and provenance. There is no long-lived `NPM_TOKEN`; do not add one.

One-time setup:

1. Log in to npm as the package owner and open the package's Trusted Publisher settings.
2. Choose **GitHub Actions** and enter: organization or user `amir1824`, repository `mcp-trellis`, workflow filename `publish.yml` (filename only), environment name `release`.
3. In GitHub, create the environment `release`: deployment branches and tags `main` and `v*`, required reviewers set.

npm does not validate that form on save. A typo shows up as `ENEEDAUTH` or a 404 on `PUT …/mcp-trellis` when the workflow runs; fix the form and re-run.

Each release:

1. Bump `"version"` in `package.json` and commit (`chore: release vX.Y.Z`).
2. Push `main`. Optionally tag it (`git tag vX.Y.Z && git push origin vX.Y.Z`).
3. Actions → **Release** → **Run workflow** (manual only; a tag push does not start it). Pick `main` or the tag. For a tag, the workflow checks that it matches `package.json`.
4. Approve the `release` environment when the run asks.

The `verify` job runs lint, typecheck, tests, e2e, build and `npm run smoke:pack` before `publish`.
