# Baselines and proposed regression budgets for 3.4.0

Status: **Proposed.** Budgets are approved by the maintainer. Measured 2026-11-25 on one macOS machine (Darwin 25.6.0), Node v22.23.4, `src/` identical to `main` at commit `82526c9`. One machine and one day: re-measure on the maintainer's CI before approving a latency budget.

## Package size

Command (after `npm run build`):

```bash
npm pack --dry-run --json
```

Result (name, version, `size`, `unpackedSize`, `entryCount`):

```json
{"name":"mcp-trellis","version":"3.4.0","size":239704,"unpackedSize":871067,"entryCount":331}
```

The tarball includes `dist/`, `docs/*.md` and `docs/diagrams/**` (`package.json` `files`). The new `docs/modernization/` and `docs/adr/` folders are subfolders of `docs/` and are not matched by `docs/*.md`, so they do not ship.

## Request latency

Command (after `npm run build`):

```bash
node scripts/measure-baseline.mjs
```

Measures `tools/list` and one `tools/call` against `createMcpHandler` with one fixed principal, 200 warm-up requests and 2000 timed requests, in two ways: calling `handler.fetch` in-process, and over a loopback HTTP server through `asNodeHandler`. Output of the last of three consecutive runs (p50 and p95 in milliseconds):

```text
{"scenario":"handler.fetch in-process","method":"tools/list","warmup":200,"samples":2000,"p50Ms":0.022,"p95Ms":0.032}
{"scenario":"node http loopback","method":"tools/list","warmup":200,"samples":2000,"p50Ms":0.104,"p95Ms":0.185}
{"scenario":"handler.fetch in-process","method":"tools/call","warmup":200,"samples":2000,"p50Ms":0.014,"p95Ms":0.018}
{"scenario":"node http loopback","method":"tools/call","warmup":200,"samples":2000,"p50Ms":0.075,"p95Ms":0.116}
```

Range over the three runs: in-process p95 0.018 to 0.059 ms; loopback p95 0.106 to 0.221 ms.

`scripts/` now holds 9 files, one over the 8-per-folder threshold; the script stays there because it belongs with the repository's other check and measurement scripts, and splitting that folder is outside this slice.

**What is not measured:** the OAuth endpoints, network latency, host ports (real authentication, context and audit), and any edge runtime. Latency on an edge runtime is not measured at all; the Worker example is compile-checked only.

## Integration complexity

Command:

```bash
npm run check:quickstart
```

Result: `check-quickstart OK (15/15 lines)`: the README quickstart is 15 non-empty, non-comment lines, the existing maximum. `createMcpApp` has 3 required options (`serverInfo`, `tools`, `auth`) and 23 optional ones (`src/app-options.ts:72-150`). The measure is a proxy: it counts what a developer writes, not how long integration takes.

## Proposed regression budgets

| Measure | Baseline | Proposed budget | Check |
|---|---|---|---|
| Packed size | 239,704 bytes | at most 275,000 bytes (about +15%) | `npm pack --dry-run --json` |
| Unpacked size | 871,067 bytes | at most 1,000,000 bytes (about +15%) | `npm pack --dry-run --json` |
| Runtime dependencies | 0 | 0 | `package.json` has no `dependencies` |
| In-process p95, `tools/list` and `tools/call` | 0.018 to 0.059 ms | at most 0.25 ms | `node scripts/measure-baseline.mjs` |
| Loopback p95, `tools/list` and `tools/call` | 0.106 to 0.221 ms | at most 0.5 ms | `node scripts/measure-baseline.mjs` |
| README quickstart lines | 15 | at most 15 (already enforced) | `npm run check:quickstart` |
| Required `createMcpApp` options | 3 | 3: a new required option is a breaking change | review of `src/app-options.ts` |

The latency budgets are loose on purpose: the numbers are sub-millisecond and move between runs, so a tight limit would fail on noise. They guard against an order-of-magnitude regression, not a few percent.
