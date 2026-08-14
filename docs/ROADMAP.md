# mcp-trellis — roadmap

Status: 2026-08-14. Written against MCP spec revision `2026-07-28`.

## What this library is

> **The easy way to build a secure MCP server that works with Claude, Gemini,
> and Codex** — on any Web-standard runtime, with no database and no vendor.

The differentiating axis is **clients**, not runtimes. Runtime portability is
table stakes; the official SDK has it too. What nobody in TypeScript ships is
both halves — the MCP handler *and* a self-hosted OAuth authorization server —
in one package you can drop into a Next.js route or a Deno server.

| | Portable runtime | Self-hosted | AS included | Zero-dep |
|---|---|---|---|---|
| Official SDK v2 | yes | yes | **no** | no |
| `workers-oauth-provider` | Workers only | yes | yes | — |
| Auth0 / Authlete / Clerk / WorkOS | yes | **no** (SaaS) | yes | — |
| Better Auth | yes | yes | yes, but full stack + DB | no |
| **mcp-trellis** | yes | yes | yes | yes |

The official SDK explicitly does not provide an authorization server — it offers
SDK-level opt-ins and expects you to bring the infrastructure. That gap is the
product.

### The rule that decides design questions

**If a user can forget to do something and the result is a security hole, it
goes in the code, not the README.** Audience validation moved into
`createMcpApp` for exactly this reason.

### The acceptance test

From `npm install` to a connected client: **under 15 lines and one secret.**
Anything that forces the user to route requests, read an RFC, or install a
second package fails.

---

## Shipped

**Phase 0 — trust.** Query-string tokens now cover RFC 6750's `access_token`;
audit fires on every denial including transport-level ones, and a throwing audit
port can no longer fail a request; tool exceptions are redacted by default;
a relative `loginUrl` resolves instead of throwing; explicit `id: null` returns
a proper JSON-RPC error.

**Phase 1 — the app layer and the Gemini unblock.**

- `createMcpApp` — one call mounts tools, the AS, both discovery documents, and
  the routing between them. `createMcpHandler` / `createOAuthRouter` stay
  exported for anyone who wants to compose the pieces.
- **Audience validation is enforced by the library.** `verifyToken` returns the
  token's audience; `createMcpApp` compares it against `canonicalResource` and
  rejects mismatches before any tool runs.
- **Client profiles** (`claude` / `gemini` / `codex`) compose the redirect
  allowlist and the advertised token-endpoint auth methods. Client-specific
  knowledge is the asset, so it lives in the library.
- **Confidential clients and pre-registration** via a `clientStore` port —
  `client_secret_basic` and `client_secret_post`. This is what Gemini Enterprise
  needs, and it was previously impossible: the AS advertised `["none"]` only.
  Secret storage and comparison stay in the port; credentials never enter the
  library.
- **Naming only confidential clients is enforced, not just advertised.**
  The first cut of this let `clients: ["gemini"]` configure the AS's metadata
  while leaving DCR and the loopback allowlist wide open — a self-registered
  public client could still complete a normal PKCE flow and get a token,
  quietly defeating the "confidential clients only" intent. Fixed:
  `allowUnregisteredClients: false` (derived automatically by `createMcpApp`
  when no configured client registers dynamically) unmounts `/register`, drops
  it from AS metadata, and rejects any `client_id` the `clientStore` doesn't
  resolve — `unauthorized_client` at `authorize`, `invalid_client` at `token`.
  Public type break: `AuthorizationServerMetadata.registration_endpoint` is
  now optional (`string | undefined`), omitted when DCR is off.
- **Scope threaded end-to-end.** `authorize` validates the requested scope
  against the advertised set, the auth code carries the grant, and
  `mintAccessToken` receives it. `ToolDef.scope` finally sits on a chain that
  reaches the OAuth layer.
- Node adapter drains the request stream when `req.body` is absent, so raw
  `http.createServer` works without a body-parser.
- `[::1]` added to the loopback redirect allowlist.
- **`defineTool` / `apiTool`.** The library was easy to run but not easy to
  *author tools for* — every tool hand-wrote its own JSON Schema disconnected
  from its handler's types, and every API-backed tool re-invented fetch/error
  plumbing. `defineTool` adds optional Standard Schema v1 parsing in front of
  parsing in front of a handler — typed args, validation failures short-circuit
  before the handler runs. `apiTool` builds on it: give it `request` (+
  optional `respond`) and get a working REST-call tool, non-2xx handled as
  `isError` automatically. `inputSchema` (JSON Schema, for `tools/list`) stays
  required and separate — no library-agnostic way exists to derive it from an
  arbitrary Standard Schema validator, so the two must be kept in sync by hand.
- **No host port can crash `fetch`.** Nothing guarded `authenticate`,
  `context`, `resolveUser`, `mintAccessToken`, `clientStore`, etc. — any of
  them throwing turned `.fetch()` into a rejected promise instead of a
  `Response`, with the fallout depending on the runtime (a generic error page
  on Workers, a hung socket with no response ever sent on raw
  `http.createServer`). `createMcpHandler`, `createOAuthRouter`,
  `createMcpApp`, and `asNodeHandler` now each catch at their own boundary and
  return a real `500` instead.

- **RFC 7009 token revocation.** The library never stores access or refresh
  tokens, so revocation is a host port — `revokeToken` — advertised and mounted
  only when implemented (same honest-advertisement pattern as refresh).
  Well-formed authenticated `POST /revoke` returns 200 even if the token is
  unknown (`invalid_request` 400 and `invalid_client` 401 still apply).
  Stolen-token invalidation lives in the host store that `verifyToken` and
  `refreshAccessToken` consult.

- **Claims on `Principal`.** Optional `claims` from `verifyToken` /
  `VerifiedToken` flow into `context` (plan/role metadata — not the
  Host→tenant isolation key). Host-origin allowlisting (`allowedOrigins` on
  `asNodeHandler`) is **required** when origin is Host-derived.

- **`validateArgs` fail-fast.** With `validateArgs: true`, unsupported JSON
  Schema keywords throw at `createToolRegistry` construction instead of
  silently looking enforced. Default (off) is unchanged.

---

## Next

### 1. CIMD — Client ID Metadata Documents

DCR is deprecated as of `2026-07-28`; CIMD is the recommended replacement and
the direction Claude and Codex are heading. The client publishes JSON at an
HTTPS URL and uses that URL as its `client_id`; the AS resolves it on demand.

AS-side requirements: detect URL-formatted `client_id`; fetch it; **MUST**
validate the document's `client_id` equals the URL exactly; **MUST** validate
the request's `redirect_uri` against the document's `redirect_uris`; **SHOULD**
cache respecting HTTP cache headers; advertise
`client_id_metadata_document_supported: true`.

This slots cleanly into the existing shape — pure `fetch` plus validation, with
caching as a port. It also completes the picture: the spec defines exactly three
registration mechanisms, and they map one-to-one onto the three clients.

```
CIMD             → Claude, Codex     (public + PKCE)
pre-registration → Gemini Enterprise (confidential)   ← shipped
DCR              → legacy fallback                    ← shipped
```

The security work is the real work: an AS that fetches attacker-supplied URLs is
an SSRF engine unless it blocks private/loopback/link-local ranges and DNS
rebinding, caps redirects, response size, and timeout, and refuses non-HTTPS.
Cloudflare's implementation is a useful reference for what "done right" means
(5 KB cap, 10 s timeout, public clients only).

Note: CIMD is not unclaimed. Authlete, Auth0, Clerk, and `workers-oauth-provider`
all ship it. The claim here is narrower and still true — none of them is a
portable, self-hosted, zero-dependency library.

### 2. RFC 9207 — `iss` in the authorization response

Add `iss` to the authorize redirect and
`authorization_response_iss_parameter_supported` to AS metadata. Small, and a
spec-level SHOULD.

### 3. Protocol currency — `2026-07-28`

Deferred deliberately: Claude, Gemini, and Codex all work against current
revisions today, and the official SDK already covers dual-era for anyone who
needs it now. But a batteries-included server that speaks an outdated revision
is worse than useless, so this becomes mandatory once real clients move.

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
- **No embedded login UI, token store, or IdP** — the ports stay the product
- **No resources / prompts** — a real limitation; revisit on demand
- **No DPoP** — sender-constrained tokens; connectors use bearer + PKCE
- **No PAR (RFC 9126)** — pushed authorization requests
- **No `client_credentials`** — connectors are user-delegated; this AS is authorization_code (+ optional refresh)

Deferred until asked: MRTR (`input_required`), `subscriptions/listen`,
`io.modelcontextprotocol/tasks`.

## Known gaps

Tracked, not scheduled: `pruneMemory` scans the whole jti map on every code
consume; `mcpWwwAuthenticate` and `wwwAuthenticateHeader` build the same
header twice. (Unsupported JSON Schema keywords under `validateArgs: true`
now throw at `createToolRegistry` construction — no longer a silent gap.)
