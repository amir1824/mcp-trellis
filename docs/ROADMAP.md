# mcp-trellis — roadmap

Status: 2026-11-07. Written against MCP spec revision `2026-07-28`. What shipped,
version by version, is in [CHANGELOG.md](../CHANGELOG.md).

## What this library is

> **Existing SaaS → authenticated AI connector SDK** — MCP + self-hosted OAuth
> AS in one npm install, on any Web-standard runtime, with no database and no
> vendor.

The differentiating axis is **clients**, not runtimes. Runtime portability is
table stakes; the official SDK has it too. mcp-trellis puts both halves — the MCP
handler *and* a self-hosted OAuth authorization server — in one zero-dependency
package that reuses the session your app already has, so you can drop it into a
Next.js route or a Deno server.

The official TypeScript SDK v2 ships resource-server helpers only and never
issues tokens. How mcp-trellis compares with Better Auth, `workers-oauth-provider`,
Scalekit and WorkOS is in the
[README](../README.md#compared-with-the-alternatives).

### The rule that decides design questions

**If a user can forget to do something and the result is a security hole, it
goes in the code, not the README.** Audience validation moved into
`createMcpApp` for exactly this reason.

### The acceptance test

From `npm install` to a connected client: **at most 15 lines and one secret.**
Anything that forces the user to route requests, read an RFC, or install a
second package fails. `npm run check:quickstart` enforces the line count.

---

## Next

### 1. Protocol currency — `2026-07-28`

Deferred deliberately: the revisions implemented today (`2024-11-05`,
`2025-03-26`, `2025-06-18`) are what clients negotiate with this library, see
[compatibility.md](compatibility.md). But a batteries-included server that
speaks an outdated revision is worse than useless, so this becomes mandatory once
real clients move.

Work: remove `initialize` / `ping`, add `server/discover` (MUST), carry protocol
version and client capabilities in `_meta` per request, `resultType` on every
result, `ttlMs` / `cacheScope` on `tools/list`, `Mcp-Method` / `Mcp-Name`
headers, deterministic `tools/list` ordering. Add `2025-11-25` and `2026-07-28`
to the version table and stop defaulting to the oldest revision.

---

## Non-goals

Backed by the spec, not just by our own scoping:

- **No sampling / roots / logging** — deprecated in `2026-07-28`
- **No sessions** — removed from the protocol
- **No SSE resumability** — removed from the transport
- **No HTTP+SSE transport** — deprecated; Gemini Enterprise refuses it outright
- **No login UI, token store, or IdP** — the ports stay the product. The
  `/authorize` consent/approval screen is shipped (built in, overridable),
  since it's a security control determined by protocol data the library
  already holds, not by your IdP or branding; login itself stays yours
- **No resources / prompts** — a real limitation; revisit on demand
- **No DPoP** — sender-constrained tokens; connectors use bearer + PKCE
- **No PAR (RFC 9126)** — pushed authorization requests
- **No `client_credentials`** — connectors are user-delegated; this AS is authorization_code (+ optional refresh)

Deferred until asked: MRTR (`input_required`), `subscriptions/listen`,
`io.modelcontextprotocol/tasks`.
