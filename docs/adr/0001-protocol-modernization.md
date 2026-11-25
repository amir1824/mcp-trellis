# ADR 0001: Modernize the protocol layer in place, do not adopt the SDK

Status: **Proposed**
Date: 2026-11-25
Ticket: SCRUM-25, slice T1 (discovery, gap analysis, architecture decision)
Decider: the maintainer. This record is a recommendation; it is not approved, and nothing in it is built.

## Context

`mcp-trellis` 3.4.0 supports MCP 2024-11-05, 2025-03-26 and 2025-06-18 with zero runtime dependencies. The README says the 2026-07-28 revision is planned and not supported. The [capability matrix](../modernization/capability-matrix.md) lists what 2026-07-28 changes: no handshake, `server/discover`, per-request `_meta`, `resultType`, new headers, new error codes, cache hints, and the deprecation of Dynamic Client Registration in favour of Client ID Metadata Documents. The [SDK comparison](../modernization/sdk-comparison.md) compares keeping the code with adopting the official TypeScript SDK. The [baselines](../modernization/baselines.md) give the numbers a regression budget is measured against.

Constraints taken from the ticket: preserve BYO authentication and authorization boundaries; keep zero runtime dependencies unless an ADR approves one; keep public APIs and client compatibility; keep Node and edge compatibility; reuse before adding; avoid a rewrite or SDK migration without demonstrated justification; keep experimental extensions optional and off by default; follow semantic versioning.

## Decision (recommended)

1. **Keep the current implementation and add 2026-07-28 behind the requested protocol version.** A request that asks for 2026-07-28 gets the new behaviour; every request for an older version gets byte-identical answers. This is additive: a minor release (3.5.0), not a major one.
2. **Do not adopt the official SDK.** The default is to keep the code, and the SDK comparison found no demonstrated justification on the facts it could read: the v1 package has 17 runtime dependencies against zero here and about five times the unpacked size; Workers support and a Request-based transport were not found. These are v1 figures: the README names v2 as the stable line and the v2 packages' dependencies were not readable (open point 5), so this decision is weaker than it reads until that is checked.
3. **Make every cache hint safe by construction.** Any `ttlMs` and `cacheScope` the library adds defaults to `cacheScope: "private"`. Anything served only after authentication or a scope check (`tools/list`, `resources/list`, `resources/read`, `tools/call` results) is `private`, even when its content is the same for every permitted caller, because `public` lets a shared cache serve it to a caller who failed the check. `public` is allowed only for a result the server serves to anyone without authentication. This is this ADR's rule, stricter than the spec's text, which allows `public` for any result identical for every user. `private` protects against shared caches only: the T3 tests must also cover a cache kept across principals by a client, whose key must include the credential or principal. Authorization stays enforced on each request, never delegated to the hint.
4. **Keep experimental extensions optional and off by default.** MCP Skills is not started by this decision; its spec version must be pinned first (matrix, U-5).
5. **Dependencies:** no runtime dependency is proposed. Whether an SDK client may be added as a development-only conformance peer is the maintainer's decision, not made here.

## Alternative rejected: adopt the official TypeScript SDK

Rejected on the facts read, not forever: it breaks the zero-dependency constraint, it is a major version for every consumer, and what it offers for host-owned authentication was not found. The recommendation changes if the three conditions in the comparison ("What would change the recommendation") are shown with a primary source.

## Consequences

- T2 becomes a version-aware layer in `src/mcp/` (discover, `_meta`, `resultType`, headers, error codes, cache hints) plus conformance tests; T3 reviews CIMD fetching and the new caches; T4 and T5 follow the proposed scope in the matrix.
- The ticket's section 8 items stay out. No item on that list is made mandatory by 2026-07-28 on the pages read.
- Older versions keep `-32002` and the assumed `2025-03-26` header rule; only the new version drops them.
- Dynamic Client Registration stays on by default. The spec deprecates it with an earliest removal on or after 2027-07-28; the migration guide should say so.
- A latency number measured on one machine is not a promise; the budgets are loose by design.

## Risks

- **Spec facts not confirmed** (matrix, Unverified U-1 to U-8): in particular whether `cacheScope` is required, the Skills status, and the changes between 2025-06-18 and 2025-11-25.
- **A wrong cache scope is a data leak.** Decision 3 is the control; T3 must test it with two users.
- **Edge compatibility is a property of the design, not a measurement:** the Worker example was never run in this analysis.

## Open points for the maintainer

1. Approve or change the proposed scope table (matrix, section 5): rows per task and release.
2. Prompts (matrix O-12) are not in the ticket: in or out?
3. Cancellation reaching tool handlers (O-11) and `outputSchema` (O-8): in T2, later, or never?
4. Approve the budgets in the baselines document, after re-measuring on CI.
5. Re-check the SDK v2 packages (dependencies, Workers, auth) before this ADR is approved; those facts were not readable.
6. Whether an SDK client may be a development-only conformance peer.
7. Keep `hideToolsOutsideScope` defaulting to `false` (documented behaviour), or change it in a major release. *Answered in T3: kept at `false`; the restrictive profile in `docs/security.md` turns it on.*
8. With the option on, a `tools/call` for a hidden tool still answers 403 and names the scope, while `resources/read` answers as unknown (matrix, R20 assessment): should T3 make a hidden tool answer like an unknown one? *Answered in T3: yes, as the opt-in value `"strict"`; `true` keeps the 403 step-up answer because changing it would be a breaking change.*

## Rollback

This record and the documents it links are the only change in T1. Revert the commit; no code, configuration or published artifact depends on it.
