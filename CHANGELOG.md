# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
- **Request body size limits** — new `src/body.ts`
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
  `src/adapters/node.ts`, `src/validate.ts`, and `src/oauth/codes.ts`.

## [0.2.1] - Prior release

See git history.
