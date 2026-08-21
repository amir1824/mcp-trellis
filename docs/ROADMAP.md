# mcp-trellis — roadmap

Status: 2026-08-21. Written against MCP spec revision `2026-07-28`.

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

**Phase 2 — the authorize endpoint (0.2.2 / 0.3.0).**

- **Consent step at `/authorize`.** A resolved session no longer issues a
  code and redirects on its own; it renders an approval interstitial (built
  in, or your own via `consent.render`) and only issues a code after an
  explicit `POST ${oauthPath}/consent` approval. Closes a cross-site flow
  where an attacker-controlled page could otherwise walk a logged-in user
  through `/authorize` with an attacker-chosen `client_id`/`code_challenge`
  and a loopback `redirect_uri`, catching the code with a local listener —
  PKCE alone does not defend against this, it proves possession of the
  verifier, not the identity of a legitimate client. Approval tickets are
  AES-GCM sealed (`sealed.ts`), single-use, and re-checked against the
  resolved user at redemption.
- **DCR `client_id` is bound to its own `redirect_uris`**, zero storage — the
  id issued by `/register` is a sealed, self-verifying assertion of the list
  it registered. Stops a substituted `redirect_uri` on a legitimate
  connector's id (not impersonation via self-registration — the consent step
  above is what stops that). `requireRegisteredClients` (default `true`
  since 1.0) is the stricter default, and a direct stepping stone to CIMD below.
- **`codeSecret` is validated** — minimum 32 characters, and the literal
  values this package's own docs/examples publish are denylisted by name.
  It is the single key that can forge an auth code, consent ticket, or DCR
  client assertion for any userId/scope/resource, and had no validation at
  all before this.
- **Loopback redirect allowlist narrowed** — `localhost` and `https:`
  loopback are no longer accepted (RFC 8252 §8.3); a `redirect_uri` carrying
  a fragment or embedded credentials is rejected for every predicate, not
  only loopback.
- **`defaultScopes` required for multi-scope servers.** `createOAuthRouter`
  now throws at construction when `scopes` has more than one entry and
  `defaultScopes` is unset, instead of silently granting the full advertised
  set to a client that asked for nothing.
- **`timingSafeEqual("", "")` now returns `false`**, not `true` — a public
  export, so a host comparing a presented secret against an unset stored one
  no longer authenticates.
- **Request body size limits** on `/mcp`, `/token`, `/revoke`, and
  `/register` — previously unbounded on every one of them.

**Phase 3 — credentials and correctness (0.4.0).**

- **Auth codes sealed (AES-GCM), not signed-only.** v1 (HMAC) codes were
  readable by anyone who saw one; v2 codes are encrypted too. Soft
  migration in 0.4.0 / 0.5.0 (read both, write v2); **1.0.0 drops v1 reading**.
- **`ClientStore.secretHash`**, preferred over `verifySecret`: return a
  stored hash from the new `hashClientSecret` and the library does the
  comparison with the same constant-time primitive it uses everywhere
  else. Keyed by `codeSecret` — no second secret to manage.
- **Client-auth enumeration oracle closed.** `/token` and `/revoke`
  collapsed five distinguishable error messages into one; a locked-down
  server also pays a fixed-cost dummy comparison for an unknown
  `client_id`, so response timing can't distinguish "unknown" from
  "known, wrong secret" either. Unaffected: public-client traffic, and
  `/authorize`'s deliberately-still-descriptive `unauthorized_client`.
- **`/revoke` accepts JSON**, matching `/token` — previously form-only,
  so a JSON revoke silently failed while the caller believed it worked.
- **`apiTool` no longer forwards the upstream error body by default** —
  status only; opt in via the new `onError`.
- **`missingObjectType`** — a schema using `properties`/`required`
  without `type: "object"` now throws at construction under
  `validateArgs: true`, and is enforced at runtime by dispatching on the
  value's actual shape rather than trusting a schema author remembered to
  declare `type`.
- **Union `type` arrays** (`type: ["string", "null"]`) now evaluate
  correctly — previously always failed.
- **`/authorize` errors redirect to the client's callback** (RFC 6749
  §4.1.2.1) once `redirect_uri` is validated, instead of a bare JSON body
  the connector never parses — this was silently connector-breaking.

**Phase 4 — protocol correctness and observability (0.5.0).**

- **`jsonrpc` validated on every `/mcp` request** — `-32600` on anything
  but exactly `"2.0"`, including a missing field. Previously accepted
  silently.
- **`MCP-Protocol-Version` header read and validated**, per the
  2025-06-18 spec — unsupported → 400, missing → assumed `2025-03-26`
  (the spec's own compatibility default), not checked on `initialize`
  (which is what negotiates the version). Previously only appeared in the
  CORS allow-list, never actually read.
- **`initialize` defaults to the newest supported protocol version**
  (`2025-06-18`) for a missing/unrecognized request, not the oldest.
- **401 responses echo the real request id** instead of hardcoding `null`.
- **`/mcp/` routes identically to `/mcp`.** `canonicalResource` normalizes
  its `resourcePath` argument internally, so route matching, `/authorize`,
  and `/token` all agree — previously only some call sites normalized a
  trailing slash and others read a raw, unnormalized value.
- **`createOAuthRouter` refuses to construct** if `oauthPath` would equal
  `resourcePath` (they'd shadow each other) or if `resourcePath` starts
  with `/.well-known` (reserved for discovery documents).
- **`auditTimeoutMs`** (default 1000ms) — a hanging `ports.audit` can no
  longer stall a response indefinitely; it already couldn't fail one.
- **`OAuthPorts.audit` / `McpAppAuth.audit`** — the OAuth-side twin of the
  MCP audit hook. Sees the real reason behind a collapsed `invalid_client`
  or a rejected `codeSecret`, which the caller never does.

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

## Known gaps

Tracked, not scheduled: `pruneMemory` scans the whole jti map on every code
consume; `mcpWwwAuthenticate` and `wwwAuthenticateHeader` build the same
header twice. (Unsupported JSON Schema keywords under `validateArgs: true`
now throw at `createToolRegistry` construction — no longer a silent gap.)
