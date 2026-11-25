# Keeping the current implementation or adopting the official TypeScript SDK

Status: **Proposed.** Input to ADR 0001. Prepared 2026-11-25 for SCRUM-25 slice T1.

The SDK facts below were read from the SDK's own repository, its documentation page and the npm registry on 2026-11-25. A fact not on a page that was read is marked `not found`; nothing is filled in from memory. Sources:

- `https://github.com/modelcontextprotocol/typescript-sdk` (README)
- `https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/package.json`
- `https://modelcontextprotocol.io/docs/sdk`
- `https://registry.npmjs.org/@modelcontextprotocol/sdk/latest`

## Decision rule (default: keep the current code)

The ticket says to avoid "a complete protocol rewrite or SDK migration without demonstrated justification". So the default is to keep and extend `mcp-trellis`, and an SDK recommendation must show a justification that the table below does not already answer. On the facts read, no such justification was demonstrated; the open facts that could change this are listed under "What would change the recommendation".

## What was read about the SDK

| Fact | Value | Source |
|---|---|---|
| Line the README calls stable | v2: packages `@modelcontextprotocol/server` and `@modelcontextprotocol/client`, plus optional `@modelcontextprotocol/node`, `/express`, `/fastify`, `/hono` | README on `main` |
| npm `latest` for `@modelcontextprotocol/sdk` | 1.32.2 | npm registry JSON |
| The two sources agree? | **No.** The README says v2 is the stable line; npm `latest` is still the v1 package. The v2 packages were not confirmed on npm | README, registry |
| Spec revision implemented | the README says `main` implements 2026-07-28; other supported revisions `not found` | README |
| Maintenance of v1 | the README says v1 gets fixes "for at least six months after the v2 release (2026-07-27)" | README |
| Runtime dependencies of v1.32.2 | 17: ajv, zod, cors, hono, jose, express, raw-body, ajv-formats, cross-spawn, eventsource, content-type, pkce-challenge, @hono/node-server, json-schema-typed, eventsource-parser, express-rate-limit, zod-to-json-schema | registry JSON |
| Runtime dependencies of the v2 server and client packages | `not found` (the `packages/` folder was not readable) | |
| Node engines | v1.32.2: `>=18`; repository root on `main`: `>=20` | registry, `package.json` |
| Unpacked size | v1.32.2: 4,492,221 bytes, 701 files; v2 `not found` | registry JSON |
| Runtimes named | "Node.js, Bun, and Deno" | README |
| Cloudflare Workers | `not found` | |
| Request-based (Web Standard) transport | `not found`; the README names a Node HTTP wrapper and Hono and Fastify middleware | README |
| Authorization | server "auth helpers" and client "OAuth helpers" named; server-side protected resource metadata, bearer middleware and CIMD `not found` | README |
| License | README: Apache-2.0 for new contributions, MIT for existing code; npm v1.32.2: MIT | README, registry |
| Tier on the SDK page | "Tier 1"; the tier definitions `not found` | `modelcontextprotocol.io/docs/sdk` |

## Comparison

| Concern | Keep `mcp-trellis` | Adopt the SDK |
|---|---|---|
| Runtime dependencies (ticket: zero unless an ADR approves) | 0 (`package.json` has no `dependencies`) | v1 has 17; v2 `not found`. Adopting means the maintainer approves a dependency tree in an ADR |
| Package size | 871,067 bytes unpacked, 239,704 bytes packed ([baselines](baselines.md)) | v1: 4,492,221 bytes unpacked, about 5 times larger; v2 `not found` |
| 2026-07-28 support | missing today ([matrix](capability-matrix.md), M-1 to M-9); work for T2 | stated for `main` by the README; not verified here by running it |
| Maintenance burden | the maintainer follows spec changes | the SDK follows them; spec revisions still reach the library through SDK upgrades |
| Time to the first compliant release | T2 effort on a codebase the maintainer owns | an integration effort plus the cost of fitting BYO auth (below); not estimated here |

## Runtime compatibility (Node and edge)

- `mcp-trellis`: handlers take and return Web `Request` and `Response` (`src/mcp/dispatch.ts:41-43`), so the same code runs under Node and under a Worker; Node is `>=20` (`package.json` `engines`). The Cloudflare Worker example is **compile-checked only and was not run** (`examples/cloudflare-worker.ts:1-3`), and this analysis did not run it either. Edge compatibility is therefore a design property that is not verified by an execution.
- SDK: Node, Bun and Deno are named; Workers and a Request-based transport are `not found`. Whether the SDK satisfies the ticket's edge-runtime constraint is unknown from what was read.

## BYO authentication and authorization boundaries

- `mcp-trellis`: the host supplies `resolveUser`, `loginUrl`, `mintAccessToken` and `verifyToken` (`codeStore` is optional in the type but is needed for single-use codes in production, `src/app-options.ts:41-60`); the library checks the token audience, scopes and consent (`src/app-options.ts:23-60`, `src/app.ts:48-63`). The boundary between library authorization and application tenant isolation is documented in the README ("OAuth tells your server who is calling...") and `docs/security.md`.
- SDK: auth helpers exist; what the application must supply is `not found`. Fitting the SDK to the host-owned user lookup, scope model and per-tool scope checks was not assessed and would be part of any migration.

## Public API and semantic-version impact

| Path | Public API impact | Version impact |
|---|---|---|
| Keep and add 2026-07-28 behind the requested protocol version | additive: new behaviour only for requests that ask for the new version; `PROTOCOL_VERSIONS` gains a member (`src/server.ts:60`) | minor (3.5.0), if older clients see byte-identical responses |
| Keep, but change what old versions return (for example `resultType` on every result, or `-32022` for an unknown version header) | changes responses existing clients parse | major, or not done |
| Change `DEFAULT_PROTOCOL_VERSION` (`src/mcp/protocol.ts:7`) to the new version | clients that rely on the default see different behaviour | major |
| Adopt the SDK | replaces `createMcpHandler`, `ToolDef`, `ToolRegistry` and the OAuth router unless wrapped | major, plus a dependency approval |

## What would change the recommendation

Any of these, shown with a primary source, would justify a second look at adoption:

1. The v2 server package has zero or very few runtime dependencies and a Request-based transport that runs on Workers.
2. The SDK ships server-side protected resource metadata, audience validation and CIMD that fit a host-supplied user lookup without a second authorization layer.
3. A maintainer decision that the cost of following the spec by hand exceeds the cost of the dependency tree.

A cheap middle path, for the maintainer to accept or refuse: use the SDK **client** as a development-only conformance peer in tests. It adds no runtime dependency; it still adds a dev dependency, so it is not proposed without the maintainer's yes.
