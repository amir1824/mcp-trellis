# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.1.0] - 2026-09-15

### Security

- **CIMD SSRF deny-list covers full-form IPv4-mapped addresses** returned by
  DNS / `cimdLookup` (e.g. `0:0:0:0:0:ffff:7f00:1`), not only compressed
  `::ffff:…` forms. Unparseable IPv6 lookup results fail closed. **Ceiling
  unchanged:** TCP connect is still not pinned to the looked-up addresses
  (zero-dep Web `fetch`); classic DNS rebinding between lookup and connect
  remains possible — keep `cimd` off unless you accept that residual risk.

### Fixed

- **The README quickstart no longer answers `initialize` with a 500.** The
  `context` port ran before every JSON-RPC method, including the public
  `initialize` and `ping` where `principal` is `null`, so
  `context: (_r, p) => ({ userId: p!.id })` threw. `context` now runs only for
  a `tools/call` that passed the unknown-tool and scope checks. A new test runs
  the README example as written.
- **`apiTool` reports a timeout that fires while the response body is still
  streaming** as `Request timed out after …ms`, instead of the redacted
  `Tool execution failed`. The fetch `AbortSignal` is threaded into the body
  read; `TimeoutError`, `AbortError`, and mid-body abort are all classified
  as timeouts.
- **`client_secret_basic` parsing follows the RFCs:** the `Basic` scheme is
  case-insensitive (RFC 7235 §2.1), and id and secret are form-decoded, so `+`
  is a space (RFC 6749 §2.3.1).
- **`/register` answers `201 Created`** (RFC 7591 §3.2.1), not `200`.

### Added

- **`mcp-trellis/advanced`** — low-level primitives (PKCE, auth codes, client
  auth, scope/resource parsing, schema validation, HTTP utils) for hosts
  assembling their own flow. Less stable than the other entry points.
- **Boolean `additionalProperties` is validated.** `additionalProperties: false`
  (the default output of `zod-to-json-schema`) used to make `validateArgs`
  throw at construction; it is now enforced. A schema-valued
  `additionalProperties` is still reported as unsupported.

### Deprecated

- The 35 symbols now in `mcp-trellis/advanced` remain importable from
  `mcp-trellis` and `mcp-trellis/oauth` as `@deprecated` aliases, identical to
  the new exports. **Removed in 3.0.** See `docs/reference.md#exports`.
- Calling `consumeAuthCode` without `codeStore`. It falls back to a
  process-local map that cannot enforce single use across instances;
  `codeStore` becomes required in 3.0.

### Changed

- `/token` and `/consent` receive the router-resolved `codeStore` and can no
  longer fall back to a store of their own. The in-memory store (with
  `allowInMemoryCodeStore`) remains process-wide, so apps built per request
  keep single-use.
- `test:coverage` runs on Node 20 (reporting only; thresholds enforced on
  Node 22 in CI). Thresholds raised from 85/75 to 94/88 lines/branches.
- `assertCodeSecret` no longer carries a hardcoded list of example secrets;
  the 32-character floor and the `do-not-reuse` marker already rejected all
  of them.
- `package-lock.json` root version synced (was stuck at `1.0.0`).
- 405 responses from OAuth endpoints carry `{ "error": "Method not allowed" }`
  like every other error body, instead of `{ "detail": "method not allowed" }`.

## [2.0.1] - 2026-09-14

### Security

- **CIMD defaults to off** (`cimd: true` to enable). Default-on fetch of
  attacker-supplied URL `client_id`s was an incomplete SSRF surface.
- **`createMcpApp` wires `cimd` / `cimdCache` / `cimdLookup`.**
- **`/token` and `/revoke` re-resolve CIMD** instead of accepting HTTPS-shaped
  `client_id`s by shape alone under `requireRegisteredClients`.
- CIMD blocks NAT64 (`64:ff9b::/96`); `http:` redirect_uris must be loopback.
- Rejected HKDF derive promises are dropped from the key cache (no poison).

### Changed

- **`auth.allowInMemoryCodeStore` removed.** Use top-level
  `allowInMemoryCodeStore` on `createMcpApp` (same as `createOAuthRouter`).

## [2.0.0] - 2026-09-14

First npm release after `1.0.0`. Tree commits labeled 1.1.x / 1.2.0 were
never published; their changes ship here together with fail-closed defaults.

### Upgrading from 1.0.0

**Breaking**

- **`codeStore` is required** unless you set `allowInMemoryCodeStore: true`
  on `createMcpApp` / `createOAuthRouter`. The silent process-local Map was
  a multi-instance auth-code replay footgun. Single-process demos and tests
  opt in explicitly.
- **`validateArgs` defaults to `true`.** Unsupported JSON Schema keywords
  and object-shaped schemas missing `type: "object"` throw at construction.
  Set `validateArgs: false` only when you intentionally skip schema checks.
- **`insufficient_scope` uses JSON-RPC `-32003`** (`JSONRPC_INSUFFICIENT_SCOPE`),
  not `-32001` (`JSONRPC_UNAUTHORIZED`). HTTP status remains 403.
- GET `/mcp` with a query-string token now returns **401** with
  `WWW-Authenticate` (same shape as POST), not a bare 400 JSON body.

**Also included from unpublished 1.1 / 1.2 tree work**

- `codeSecret` rotation via `string[]`, `hideToolsOutsideScope`,
  `ToolDef.scope: null`, `apiTool` timeout/byte caps, `InvalidOriginError`,
  refresh/revoke `requireRegisteredClients` enforcement, unknown tool →
  `-32602`, Host-derived origin URL validation, case-insensitive `Bearer`,
  register body hardening, shared in-memory jti store, HKDF key cache.

### Added

- CIMD (Client ID Metadata Documents) with SSRF hardening.
- RFC 9207 `iss` on authorize redirects.
- Unified audit sink option (`source: "mcp" | "oauth"`).
- Framework recipes: Next.js route, Express.
- README quickstart 15-line CI acceptance check.

### Security

- RFC 6750 quoted-string escaping in `WWW-Authenticate`.
- Crypto key-cache keys hash the secret; raw secrets no longer sit in Map keys.
- Outer `createMcpApp` catch audits before returning 500.

### Changed

- `publishConfig.provenance: true` restored; releases via Actions OIDC only.
- Supported versions window is `2.x` ([SECURITY.md](SECURITY.md)).

## [1.2.0] - 2026-09-14 (unpublished — folded into 2.0.0)

### Upgrading from 1.1.x

Fully additive for the common path — every existing single-scope,
single-`codeSecret`, default-options server keeps working unchanged. Two
things are worth a deliberate look before upgrading:

- **An unrecognized `tools/call` tool name is now a JSON-RPC `-32602`
  protocol error, not a successful result with `isError: true`.** A host
  that pattern-matched on the old `"Unknown tool: …"` text result needs to
  read the JSON-RPC `error` field instead. Everything else about
  `tools/call` (a tool that exists and runs, and its own thrown/returned
  errors) is unchanged.
- **A multi-scope `createMcpApp`/`createOAuthRouter` now refuses to
  construct if any tool omits `scope`.** This only fires when `scopes` has
  more than one entry — a single-scope server is never affected. Fix it by
  adding `scope: "<one of your scopes>"` to the named tool(s), or
  `scope: null` to state the omission on purpose (any authenticated
  principal, regardless of its scopes, may call it).

### Added

- **`codeSecret` accepts `string[]` for key rotation** (`OAuthPorts.codeSecret`,
  `McpAppAuth.codeSecret`) — the first entry seals new auth codes, consent
  tickets, DCR client assertions, and hashes new client secrets; every entry
  is tried when unsealing/verifying, so material sealed under an older key
  keeps working until you drop it. `ports.audit` sees a new
  `"legacy_code_secret_used"` event whenever a non-primary key was the one
  that actually verified. A single string continues to work exactly as
  before. See [security.md](docs/security.md#rotating-codesecret) for the
  full rotation procedure.
- **`hideToolsOutsideScope`** (`McpHandlerOptions`/`McpAppOptions`, default
  `false`) filters `tools/list` down to tools the calling principal's scopes
  actually satisfy. `tools/call` already enforces scope on its own
  regardless of this setting (403 `insufficient_scope`) — this only changes
  what's discoverable via `tools/list`.
- **`ToolDef.scope` accepts `null`** to explicitly state "any authenticated
  principal may call this, deliberately" — distinct from omitting `scope`
  entirely, which on a multi-scope server is now a construction-time error
  (see Upgrading above).
- **`apiTool` gets `timeoutMs`** (default 30000ms, or `false` to disable) and
  **`maxResponseBytes`** (default 1 MiB) — an upstream that never responds,
  or returns an oversized body, previously hung or unboundedly buffered the
  tool call. Both surface as `isError: true`, not a thrown exception
  `onToolError` would redact.
- **`InvalidOriginError`** (`mcp-trellis/node`) — thrown by `resolveOrigin`
  for a Host/`X-Forwarded-*` header that can't safely become an origin;
  `asNodeHandler` answers it **400**, not the generic 500 an actual
  unexpected failure gets.

### Changed

- **`requireRegisteredClients` is now enforced at `/token`'s `refresh_token`
  grant and at `/revoke`, not just at `/authorize`.** An invented public
  `client_id` that never went through `/authorize` at all could previously
  still authenticate at either. The `authorization_code` grant was never
  actually exposed by this — a redeemable code's `client_id` is bound into
  its sealed payload at `/authorize` time, where the check already ran.
- **An unrecognized `tools/call` tool name returns `-32602`
  (`JSONRPC_INVALID_PARAMS`)** instead of a successful result carrying
  `isError: true` — see Upgrading above. `ToolRegistry.call`'s own
  `isError: true` fallback for direct callers, outside the JSON-RPC
  dispatch, is unchanged.
- **`resolveOrigin` (`mcp-trellis/node`) validates through `URL`** instead of
  templating the origin string directly from headers — a Host carrying a
  path, query, fragment, embedded credentials, or a non-`http(s)`
  `X-Forwarded-Proto` is now rejected instead of silently building a
  malformed origin.
- **`parseBearer` accepts the `Bearer` scheme case-insensitively** (RFC 7235
  §2.1) — `bearer <token>` / `BEARER <token>` are now recognized, not just
  the exact-case `Bearer <token>`.
- **`readOAuthBody` rejects a duplicate form parameter and a non-scalar JSON
  field value** instead of silently keeping the last value or
  `String()`-coercing an object/array into `"[object Object]"`.
- **`/register` returns `400 invalid_client_metadata`** for malformed JSON, a
  non-object body, a non-array `redirect_uris`, or more than 10 entries —
  previously the first two silently fell back to a successful registration
  with the default callback. `redirect_uris` omitted entirely still falls
  back the same way as before.
- **`resourcePath: "/"` no longer produces a `//oauth` double slash** in the
  default `oauthPath`; `oauthPath` itself is now normalized the same way
  `resourcePath` already was (a trailing slash no longer produces
  inconsistent routes/metadata/consent-form-action paths).

### Fixed

- **Missing tool scope on `firstClientAuthError`'s auth-mismatch paths no
  longer returns faster than a real secret check** — closing a timing gap
  between "wrong auth method" / "no secret presented" (previously free) and
  every other rejection reason (already fixed-cost).
- **`validateAgainstSchema`'s `required`/`properties` use `Object.hasOwn`**
  instead of `key in record`, which also matched inherited
  `Object.prototype` members (`toString`, `constructor`, …).
- **`Access-Control-Expose-Headers: WWW-Authenticate`** is now sent — a
  browser-based MCP client previously couldn't read `WWW-Authenticate` from
  page JS even though it was on the wire, hiding the RFC 9728
  `resource_metadata` URL discovery depends on.
- **`examples/http-server.ts`, `examples/cloudflare-worker.ts`,
  `examples/multi-tenant.ts` now sign access tokens** (HMAC-SHA256 via
  WebCrypto, new `examples/signed-token.ts`) instead of encoding them as
  unsigned `base64(JSON.stringify(payload))` — the previous shape let
  anyone forge a token for any `userId`/`scope`/`resource`, a full
  authentication bypass if ever copied into something real.

### Internal

- The in-memory single-use store for auth codes and consent tickets is now
  shared (one `Map`, one throttled prune pass every 60s) instead of two
  independent, unthrottled implementations.
- Derived HKDF `CryptoKey`s (`seal`/`unseal`/`hashClientSecret`) are cached
  by `(secret, type, usage)` — a bounded 32-entry cache — instead of
  re-running `importKey` + `deriveKey` on every call.

## [1.1.1] - 2026-09-14

Behavior change worth a look before upgrading: a `tools/call` denied only for
missing scope now returns **403** instead of **401** (see below) — this
already matched the documented behavior in `docs/reference.md` and
`docs/troubleshooting.md`, the code was the one out of sync.

### Fixed

- **Consent interstitial's CSP blocked its own approval redirect in
  Chromium.** The built-in consent page's `Content-Security-Policy` set
  `form-action 'self'` only; Chromium enforces `form-action` across the
  redirect a form submission produces, not just its immediate POST target,
  so clicking Allow/Deny was silently blocked from ever reaching a
  `redirect_uri` on another origin — the common case (Claude, Gemini,
  loopback clients). The built-in page now scopes `form-action` to `'self'`
  plus the validated `redirect_uri`'s own origin; a custom `consent.render`
  setting its own CSP needs the same.
- **`mcp-trellis/node` mis-serialized a pre-parsed body-middleware body.**
  `express.urlencoded()` (and similar) hands the adapter an already-parsed
  object in `req.body`; the adapter always `JSON.stringify`-ed it regardless
  of `Content-Type`, so a form-encoded `/token` or `/consent` POST behind
  such middleware arrived as one bogus JSON-shaped form key — every OAuth
  exchange behind it silently failed at `client_id required`. Now
  re-serialized to `a=1&b=2` when `Content-Type` says
  `application/x-www-form-urlencoded`, and a stale `Content-Length` is
  dropped when the body is re-serialized.
- **`mcp-trellis/node` forwarded only the last `Set-Cookie` header.**
  `Headers.forEach` yields one `"set-cookie"` pair per cookie; calling
  `res.setHeader` once per pair made each call overwrite the previous one.
  Now sets `Set-Cookie` once via `Headers.getSetCookie()`.
- **Missing tool scope now returns 403 `insufficient_scope`, not 401**
  (RFC 6750 §3.1) — a `tools/call` from an authenticated principal that
  lacks the tool's scope was returning 401, which tells a client
  "authenticate", not "ask for a broader scope". A client implementing
  OAuth step-up on 401 re-ran the same authorize flow, got back the same
  scopes, and retried forever. `WWW-Authenticate` now carries
  `error="insufficient_scope"` and `scope="<required>"` on that response. A
  request with no principal at all (only reachable if a host explicitly adds
  `"tools/call"` to `publicMethods`) still gets a plain 401.

## [1.1.0] - 2026-09-12

Breaking for browser-origin callers — read before upgrading if a browser sends
`Origin` to `/mcp`. Also breaking for hosts that call the exported
`jsonResponse` helper with positional arguments.

### Changed

- **Browser `Origin` on MCP is fail-closed by default.** Requests that send an
  `Origin` header are rejected with **403** unless
  `allowedRequestOrigins` admits them (`["*"]` to opt out). Requests with no
  `Origin` (native / server-to-server connectors) are unchanged. Distinct from
  Node Host `allowedOrigins` on `asNodeHandler`. See [security.md](docs/security.md).
- **`jsonResponse` takes a single object** `{ data, status?, headers?, cors? }`
  instead of positional `(data, status?, headers?, options?)`. Export type
  `JsonResponseInput` from the package root.
- **npm `files` no longer ships all of `docs/`.** Published docs are
  `docs/*.md` and `docs/diagrams/**` only — launch media under `docs/launch/`
  stays out of the tarball.

### Added

- **`allowedRequestOrigins`** on `createMcpHandler` / `createMcpApp` — browser
  Origin allowlist for MCP Streamable HTTP; matching Origins are reflected in
  CORS (with `Vary: Origin`) instead of always `*`. Rejected Origins audit as
  `origin_not_allowed`.
- **JSON-RPC request shape checks** before routing: non-string `method` and
  non-scalar `id` → `-32600`; requests that omit `id` are treated as
  notifications (**202**, no body), including `ping`.
- **Refresh token `scope` (RFC 6749 §6):** optional reduced scope on the token
  request is validated against advertised scopes and forwarded as
  `RefreshAccessTokenInput.scope`. The token response `scope` comes from the
  host port only. Hosts **MUST** enforce ⊆ originally granted scopes (opaque
  refresh token — same pattern as `resource`).
- **`auditTimeoutMs` on `OAuthRouterOptions`** (default 1000ms) — `safeOAuthAudit`
  races the OAuth audit hook like MCP `safeAudit`. `createMcpApp`'s
  `auditTimeoutMs` applies to both sides.

## [1.0.0] - "Freeze"

Breaking — read before upgrading from 0.5.x.

> **Note:** this version was published manually while the CI/OIDC release
> path was being fixed and does not carry npm provenance. See
> [CONTRIBUTING.md](CONTRIBUTING.md#releasing-maintainers) — `1.0.1`+ ship
> through the hardened GitHub Actions path.

### Changed

- **`requireRegisteredClients` defaults to `true`.** Invented public
  `client_id`s are rejected unless they come from `clientStore` or this
  server's own `/register` (sealed assertion). Opt out with
  `requireRegisteredClients: false` when you intentionally accept invented
  ids. Also exposed on `createMcpApp`.
- **v1 (HMAC-only) auth codes are no longer redeemable.** Soft migration
  window from 0.4.0 closed — only `v2.` sealed codes redeem. Finish any
  rolling deploy on 0.4.x / 0.5.x before upgrading.
- **`exactOptionalPropertyTypes` enabled** in `tsconfig.build.json`.
  Optional public fields that may be assigned `undefined` are typed
  `prop?: T | undefined` (`.d.ts` shape change for consumers with the
  same flag).

### Added

- `.github/PULL_REQUEST_TEMPLATE.md` — summary, test plan, security checklist.

## [0.5.0] - "Protocol correctness and observability"

Breaking in a few places — read "Changed" before upgrading.

### Added

- **`jsonrpc` is now validated on every `/mcp` request.** A body whose
  `jsonrpc` field isn't exactly `"2.0"` (including a missing field) now
  gets `-32600`, echoing the request id when one was present. Previously
  accepted silently.
- **`MCP-Protocol-Version` header is now read and validated**, per the
  2025-06-18 spec. An unsupported value → 400. A missing value is
  accepted (the spec's own backwards-compatibility assumption for
  header-less clients). Not checked on `initialize`, which is what
  negotiates the version in the first place. Previously the header only
  appeared in the CORS allow-list — never actually read.
- **`McpHandlerOptions.auditTimeoutMs`** (default 1000ms) — `ports.audit`
  is now raced against a timeout, so a hanging sink can no longer stall a
  response indefinitely. It already couldn't fail one; "can't fail" now
  also means "can't delay past a bound." A slow sink keeps running in the
  background and can never surface as an unhandled rejection whenever it
  does finish.
- **`OAuthPorts.audit` / `McpAppAuth.audit`** — an OAuth-side metrics hook,
  mirroring the MCP-side one. `/token` and `/revoke` collapse every
  client-auth failure to one generic `invalid_client` (0.4.0's
  enumeration-oracle fix), and a rejected `codeSecret` surfaces to the
  caller only as `server_error` — this is where an operator gets the real
  reason back (`"client requires client_secret_basic, got none"`,
  `"codeSecret must be at least 32 characters"`, …) without handing it to
  an unauthenticated caller. New export: `OAuthAuditEntry`.
- **Construction-time guards on `resourcePath`/`oauthPath`** —
  `createOAuthRouter` now throws if they'd collide (shadowing one
  another) or if `resourcePath` starts with `/.well-known` (reserved for
  discovery documents).
- **`normalizeConfiguredPath`** — new export; strips a trailing slash from
  a configured path so `"/mcp/"` and `"/mcp"` behave identically.

### Changed

- **`initialize` now answers with the newest supported protocol version**
  (`2025-06-18`) when the client's requested version is missing or
  unrecognized, not the oldest (`2024-11-05`) as before.
- **401 responses now echo the real request id** instead of hardcoding
  `null`. A client correlating responses by id previously saw `null` on
  every auth/scope denial regardless of what it sent.
- **`/mcp/` (trailing slash) now routes identically to `/mcp`.**
  `canonicalResource` normalizes its `resourcePath` argument internally,
  so this fix applies everywhere it's called — `createMcpApp`'s route
  matching, `/authorize`, and `/token` all agree with each other and with
  `resourcesEqual`'s own trailing-slash handling, instead of only some of
  them normalizing and others reading a raw, unnormalized value.

## [0.4.0] - "Credentials and correctness"

Breaking in several places — read "Changed" before upgrading. No further
action needed for the auth-code format change (soft: old codes still redeem).

### Added

- **`ClientStore.secretHash`** — preferred over `verifySecret`: return a
  stored hash (from the new `hashClientSecret`) and the library does the
  comparison with the same constant-time primitive it uses everywhere else,
  instead of a host hand-rolling `stored === presented` and getting a
  timing oracle with no warning. Keyed by `codeSecret` (HKDF-derived,
  domain-separated from auth codes/consent tickets/DCR assertions) —
  deliberately not a second secret to generate and keep in sync; this
  project's whole pitch is "one secret." HMAC-SHA256, not a slow password
  hash: client secrets are high-entropy machine values, not human-chosen
  passwords, and a slow hash would burn real CPU on every token exchange
  on every runtime this library targets, Workers' request-scoped CPU
  budget included. New exports: `hashClientSecret`, `verifyClientSecret`.
- **`/revoke` accepts JSON**, matching `/token`. Previously form-only —
  a client that revoked with `Content-Type: application/json` (matching
  how it likely called `/token`) got a silent `invalid_request "token
  required"`, believing the token was dead when the request was never
  understood.
- **`apiTool`'s `onError`** — shape a non-2xx upstream response yourself.
- **RFC 6749 §4.1.2.1 error redirects at `/authorize`.** Once `redirect_uri`
  is validated, every remaining error (`unsupported_response_type`, PKCE,
  `invalid_scope`, `invalid_target`, …) now redirects to the client's own
  callback with `?error=…&error_description=…&state=…`, instead of a bare
  JSON body the connector never parses — this was silently
  connector-breaking before. `redirect_uri` validity itself, and an
  oversized `state`, stay direct JSON responses: the URI is exactly what's
  in question in the first case, and reflecting an oversized `state` back
  into its own error redirect would recreate the header-size DoS the cap
  exists to prevent in the second. New export: `buildErrorRedirectUrl`.
- **`missingObjectType`** — a schema using `properties`/`required` without
  declaring `type: "object"` (or a union including it) now throws at
  `createToolRegistry` construction under `validateArgs: true`, instead of
  silently validating nothing at those nodes. Runtime backstop: `validate.ts`
  now dispatches type-specific checks by the *value's* actual runtime
  shape rather than the schema's declared type string, so `{ properties:
  {...}, required: [...] }` is enforced against a real object even when
  reached without going through construction-time validation.
- **`type` as a union array** (`type: ["string", "null"]`) is now
  evaluated correctly — matches if the value matches *any* member.
  Previously always failed, comparing the array to a string.

### Changed

- **Auth codes are now sealed (AES-GCM), not signed-only (HMAC).** v1 codes
  were HMAC-signed but not encrypted: `userId`, `scope`, `resource`, and
  the PKCE challenge were base64url-plain inside them, readable by anyone
  who saw a code — browser history, `Referer`, proxy logs. v2 codes are
  authenticated *and* encrypted, and carry an explicit `v2.` prefix. Soft
  migration: this version reads both v1 and v2 and writes only v2, so an
  in-flight v1 code from a not-yet-upgraded instance still redeems during
  a rolling deploy. v1 reading is planned for removal in the release after
  this one — do not build anything new against it.
- **Client-auth failures at `/token` and `/revoke` collapsed to one
  generic message.** Previously up to five distinguishable
  `error_description`s ("client requires client_secret_basic",
  "client_secret required", "clientStore.verifySecret is not configured",
  "unknown client_id — this server only serves pre-registered clients", …)
  let an unauthenticated caller enumerate which `client_id`s a locked-down
  server actually knows about and how each is configured, just by reading
  error text. All five now return `invalid_client` / "client
  authentication failed". A locked-down server (`allowUnregisteredClients:
  false`) also now runs a fixed-cost dummy comparison for an unknown
  `client_id`, so the crypto-verification cost itself can't distinguish
  "unknown" from "known, wrong secret" by timing — this only runs on that
  non-default path; public-client traffic is unaffected. `/authorize`'s
  `unauthorized_client` is unchanged and stays descriptive — it's a human
  debugging a browser flow, not a bare API response.
- **`apiTool`'s default error result no longer forwards the upstream
  response body.** It's a return value, not a thrown exception, so
  `onToolError` redaction never saw it — the previous default put the raw
  upstream body straight into both the tool result and the audit log,
  which can leak internal detail, tokens, or SQL an upstream error page
  happens to echo back. Default is now status-only; use the new `onError`
  for the previous behavior (or your own redacted version of it).

## [0.3.0] - "The authorize endpoint"

Breaking. `GET /authorize` no longer redirects immediately for a resolved
session — see "Changed" below before upgrading.

### Added

- **Consent step at `/authorize`.** A resolved session no longer issues a
  code and redirects on its own; it renders an approval interstitial (built
  in, or your own via `consent.render`) and only issues a code after an
  explicit `POST ${oauthPath}/consent` approval. Closes a cross-site flow
  where an attacker-controlled page could walk a logged-in user through
  `/authorize` with an attacker-chosen `client_id`/`code_challenge`/loopback
  `redirect_uri` and catch the code with a local listener — PKCE proves
  possession by whoever holds the verifier, not by a legitimate client, so
  it does not defend against this on its own.
  - New `src/oauth/consent.ts`: `ConsentOptions.render` override,
    `preApprovedClientIds` (only honored when `clientStore` resolves the id
    — a DCR or self-invented id is never trusted to skip approval).
  - Built-in interstitial ships `Content-Security-Policy`,
    `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
    `Cache-Control: no-store`, and HTML-escapes every reflected value.
  - Approval tickets are sealed (see `sealed.ts` below), single-use, 5-minute
    TTL, and bound to the resolved user at redemption time.
  - Denial redirects to `redirect_uri?error=access_denied&state=…` per
    RFC 6749 §4.1.2.1, instead of a bare JSON error.
- **`src/oauth/sealed.ts`** — AES-GCM-256 sealing with an HKDF-derived,
  per-type key and the type bound in as AEAD associated data. Domain
  separation is structural: a consent ticket cannot unseal as a client
  assertion or an auth code, and vice versa. Shared by the consent ticket
  and DCR client-id binding below; auth codes migrate onto it in 0.4.0.
- **DCR `client_id` is now bound to its own `redirect_uris`.** `/register`
  seals the validated `redirect_uris` into the issued `client_id` itself —
  zero storage, no `clientStore` required. `/authorize` unseals a sealed id
  and validates against that list instead of the global allowlist; a
  self-invented id keeps today's behavior unless `requireRegisteredClients`
  is set. This does not by itself close the consent gap above — an attacker
  can still register their own `client_id` — but it does stop a substituted
  `redirect_uri` on a *legitimate* connector's id, and it is a direct
  stepping stone to CIMD.
  - New `OAuthRouterOptions.requireRegisteredClients` (default `false`):
    reject any `client_id` that isn't `clientStore`-resolved or
    self-issued via `/register`.
- **`OAuthRouterOptions.defaultScopes`** — required at construction once
  `scopes` advertises more than one entry; names what an omitted `scope`
  request grants instead of silently granting everything advertised.
- **Request body size limits** — new `src/http/body.ts`
  (`DEFAULT_MCP_BODY_LIMIT` 1 MiB, `DEFAULT_OAUTH_BODY_LIMIT` 64 KiB).
  Rejects early on an oversized `Content-Length`, and aborts mid-stream for
  a chunked body with no declared length. Applied to `/mcp`, `/token`,
  `/revoke`, and `/register` (413 `payload_too_large` /
  `Request too large`).

### Changed

- **`codeSecret` is validated.** Minimum 32 characters; the exact literals
  this package's own docs/examples publish are denylisted by name. A
  string form throws at `createOAuthRouter` construction; a function form
  is validated on every call. This is a full authorization-bypass key —
  a weak or copy-pasted value was previously silently accepted.
- **Loopback redirect allowlist narrowed** (`src/oauth/redirect.ts`):
  `localhost` is no longer accepted (RFC 8252 §8.3 — it's DNS-resolvable,
  not a loopback guarantee); `https:` loopback is no longer accepted
  (RFC 8252 native-app loopback redirects are `http:` only). A
  `redirect_uri` carrying a fragment or embedded credentials is now
  rejected outright, for every allowlist predicate, not only loopback.
- **`timingSafeEqual("", "")` now returns `false`.** Previously returned
  `true` (the comparison loop never runs on two empty strings, and the
  zero-length seed folds to `0`). This is a public export
  (`export { timingSafeEqual } from "mcp-trellis"`); a host comparing a
  presented secret against an unset (`""`) stored one no longer
  authenticates.
- `state` is capped at 2048 characters at `/authorize` — it's reflected
  into a `Location` header on every redirect.

### Fixed

- **`asNodeHandler` sent no response on an oversized body.** `readNodeBody`
  called `req.destroy()` — an abortive socket close — *before* the 413
  response was written, racing the response bytes against the socket
  teardown. On a real connection this reliably turned a clean 413 into an
  ECONNRESET the client saw as a network error, not an HTTP response,
  defeating the body-size cap's entire purpose. Found by the e2e suite over
  a real socket (`test/e2e/http.test.ts`), which unit tests couldn't catch
  since they call the adapter functions directly without a live connection.
  `readNodeBody` no longer destroys the socket itself; `asNodeHandler`
  destroys it one tick after the response is sent, once the bytes are
  already handed to the socket.

### Deferred

~~`exactOptionalPropertyTypes`~~ — enabled in 1.0.0.


## [0.2.2] - "Ground truth"

No `src/` behavior change. Infrastructure and test coverage only.

### Added

- Shared OAuth test harness (`test/helpers/`) normalizing `McpApp`,
  `OAuthRouter`, and a real socket behind one `fetch`-shaped interface, so
  router-level and e2e tests can share assertions.
- `test/oauth.scope.test.ts` — unit, HTTP-level, and `mintAccessToken`
  grant-binding coverage for `src/oauth/scope.ts` (previously untested).
- `test/oauth.token.test.ts` — HTTP-level coverage for `firstAuthCodeMismatch`
  (`redirect_uri`/`client_id` mismatch), PKCE verifier edge cases, code
  replay, and forged-expiry codes.
- `test/oauth.authorize.test.ts` — coverage for the `loginUrl` guard
  (`javascript:`/unparsable → 500, relative → same-origin 302).
- Hostile-URI table in `test/oauth.redirect.test.ts` (~20 rows covering
  subdomain/userinfo confusion, path traversal, IPv4 shorthand/decimal
  normalization, non-http(s) schemes, and the `http://localhost/cb` pin
  for the upcoming loopback-tightening change).
- Malformed-JSON, missing-`jsonrpc`, and unknown-tool-name coverage in
  `test/dispatch.test.ts`.
- `SECURITY.md` and `.github/ISSUE_TEMPLATE/config.yml` (private
  vulnerability reporting via GitHub Security Advisories).
- `npm run test:coverage` (Node built-in `--experimental-test-coverage`,
  85% line / 75% branch thresholds, enforced on the Node 22 CI leg).
- `.github/dependabot.yml`, `CODEOWNERS`.
- Biome as the sole lint/format devDependency (`npm run lint`).

### Changed

- `.github/workflows/publish.yml` — npm trusted publishing (OIDC) instead
  of a long-lived `NPM_TOKEN`; publishes with `--provenance`.
- `.github/workflows/ci.yml` — explicit `permissions`, a
  `concurrency` group, and actions pinned to full commit SHAs.
- `tsconfig.build.json` — `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `verbatimModuleSyntax`; fixed three latent bugs this surfaced in
  `src/adapters/node.ts`, `src/mcp/validate.ts`, and `src/oauth/codes.ts`.

## [0.2.1] - Prior release

See git history.
