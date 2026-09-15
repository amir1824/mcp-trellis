# Security

Protocol promises, library threat model, and explicit non-goals.
Ports and audience wiring: [guide.md](guide.md). Roadmap: [ROADMAP.md](ROADMAP.md).

## Protocol promises

- Notifications → HTTP **202** with an empty body
- Batch arrays → `-32600` (MCP 2025-06-18)
- Protocol version negotiated from client `initialize` params — an unrecognized or missing request falls back to the **newest** supported revision, not the oldest
- `jsonrpc` must be exactly `"2.0"` on every `/mcp` request → `-32600` otherwise, echoing the request id when one was present
- `MCP-Protocol-Version` header validated on every request past `initialize` (which is what negotiates it) — unsupported → 400; missing → assumed `2025-03-26` per the spec's own backwards-compatibility rule
- Query-string tokens rejected (`token` and RFC 6750 `access_token`)
- `tools/call` checks `principal.scopes` (`*` = all — a wildcard that passes **every** tool scope check; reserve it for trusted internal principals and never mint it for an external connector), and the OAuth grant that produced them is validated at `authorize`
- With `createMcpApp`, tokens whose audience is not this server's canonical resource are rejected by the library
- **`fetch` never rejects.** If a host port you supply (`authenticate`, `context`, `resolveUser`, `mintAccessToken`, `clientStore`, …) throws, `createMcpHandler`, `createOAuthRouter`, and `createMcpApp` all catch it and return a real `500` (`-32603` for MCP, `server_error` for OAuth) instead of an unhandled rejection — whose shape and whether it even reaches the client varies by runtime. `asNodeHandler` catches independently too, since on raw `http.createServer` a rejection there leaves the socket open with no response ever sent.

## Threat model (library)

This is a **library** threat model, not a third-party audit badge.

| Risk | Mitigation |
|------|------------|
| Attacker-driven cross-site authorization (a logged-in user visits an attacker page and is silently walked through `/authorize`, catching the code on an attacker-controlled `redirect_uri`) | **`/authorize` never issues a code directly.** A resolved session renders a consent interstitial (built in, hardened — CSP, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, escaped reflection — or your own via `consent.render`) and only issues a code after an explicit `POST ${oauthPath}/consent` approval. The approval ticket is sealed (AES-GCM, HKDF-derived per-type key, type bound in as AEAD data — see `sealed.ts`), single-use, 5-minute TTL, and re-checked against the resolved user at redemption; it can never be redeemed as an auth code or vice versa. PKCE alone does **not** defend against this — it proves possession of the verifier, not identity of a legitimate client — so this is a distinct control, not a restatement of PKCE. `preApprovedClientIds` skips the screen only for ids `clientStore` actually resolves; a DCR or self-invented id is never trusted to skip it. The built-in interstitial's CSP scopes `form-action` to `'self'` plus the validated `redirect_uri`'s own origin — Chromium enforces `form-action` across the redirect the approval POST produces, not just its immediate target, so a custom `consent.render` that sets its own CSP must do the same or the callback to the client's own origin gets silently blocked. |
| Confused deputy (token usable at the wrong MCP) | RFC 8707: `resource` required on authorize + token; bound into the auth code; must equal this AS's canonical resource (`canonicalResource(origin, resourcePath)`). Passed into `mintAccessToken` / `refreshAccessToken` so you can embed `aud`. |
| Refresh token replayed at another resource on the same AS | Library cannot inspect opaque refresh tokens — **`refreshAccessToken` MUST reject tokens not originally issued for the given `resource`** |
| Audience not enforced at the RS | **`createMcpApp` enforces this** — `verifyToken` returns the token's `audience` and the library rejects any mismatch against `canonicalResource(origin, resourcePath)`. With bare `createMcpHandler`, the check is yours. |
| Open redirect after login | Your login page must validate `next` is same-origin before redirecting |
| Auth-code replay across instances | Pass a shared `codeStore`; in-memory `jti` (the auth code's single-use id) map is process-local only |
| Origin spoofing on Node | Pass explicit `origin`, or `trustProxy: true` only behind a proxy that strips client `X-Forwarded-*`. Host-derived origin **requires** non-empty `allowedOrigins` on `asNodeHandler` (`["*"]` to opt out loudly) |
| A Host/`X-Forwarded-*` header carrying a path, query, fragment, or embedded credentials (`evil.test/../trusted.test`, `user:pass@evil.test`) building an origin string that merely looks well-formed | `resolveOrigin` always normalizes and validates through `URL`, rejecting any of those (plus a non-`http(s)` `X-Forwarded-Proto`) with `InvalidOriginError` — `asNodeHandler` answers it **400**, not the generic 500 an actual unexpected failure gets |
| Browser `Origin` on MCP (DNS rebinding / CSRF) | `allowedRequestOrigins` on `createMcpHandler` / `createMcpApp`. No `Origin` header → allowed (native clients). Omitted allowlist → **reject** any present `Origin`. `"*"` opts out. Distinct from Node Host `allowedOrigins` |
| Scope escalation at authorize | Requested `scope` is validated against the advertised `scopes` and rejected with `invalid_scope`; the grant is bound into the auth code and handed to `mintAccessToken` |
| An unscoped tool silently callable by any authenticated principal, including one holding none of the advertised scopes — the gap `defaultScopes: []` alone doesn't close, since that only governs the token grant, not per-tool enforcement | `createMcpApp` refuses to construct once `scopes` has more than one entry if any tool omits `ToolDef.scope` — pass `scope: null` to state the omission on purpose. A single-scope server has no such ambiguity and is unaffected. `tools/call` itself always enforces whatever `scope` a tool does declare, independent of this guard (403 `insufficient_scope`) |
| Scope reduction lost on refresh | Optional `scope` on the refresh token request is validated against advertised scopes and forwarded on `RefreshAccessTokenInput.scope`. **`refreshAccessToken` MUST enforce ⊆ originally granted scopes** (opaque RT — same pattern as `resource`). The token response omits `scope` when neither the port nor the grant supplies one (RFC 6749 §5.1) — clients must not assume the field is always present |
| Stolen access or refresh token | Host `revokeToken` (denylist or equivalent) that `verifyToken` and `refreshAccessToken` consult. Unknown / wrong-client tokens MUST no-op, not throw. Well-formed authenticated revoke is 200 even if the token is unknown |
| Stolen confidential-client secret | `clientStore.verifySecret` owns comparison — store hashes, not plaintext. The library never sees or persists credentials. **Prefer `clientStore.secretHash`** instead: return a stored hash from `hashClientSecret` and the library does the comparison with the same constant-time primitive it uses everywhere else, rather than a hand-rolled `stored === presented` in your own `verifySecret` being a timing oracle with no warning |
| An unauthenticated caller enumerating which `client_id`s a locked-down server knows, via distinguishable `/token`/`/revoke` error text or response timing | Every client-auth failure at `/token` and `/revoke` collapses to one `invalid_client` / "client authentication failed" — previously up to five distinguishable messages named exactly why (wrong method, missing secret, misconfigured store, unknown id). Every rejection path in `firstClientAuthError` for a client_id that *is* known — wrong auth method, no secret presented, wrong secret, no `secretHash`/`verifySecret` on file — runs the same fixed-cost dummy or real comparison before returning, so response timing alone can't tell "known client, wrong method" apart from "known client, wrong secret." An unknown `client_id` on a locked-down server (`allowUnregisteredClients: false`) pays the identical fixed cost, so the crypto-verification cost itself can't distinguish "unknown" from "known, wrong secret" either. `/authorize`'s `unauthorized_client` is unchanged and stays descriptive — a human debugging a browser flow, not a bare API response, and a locked-down server already announces the same fact by omitting `registration_endpoint` |
| Auth codes readable by anyone who sees one — browser history, `Referer`, proxy logs | Auth codes are sealed (AES-GCM, `sealed.ts`), not signed-only. Legacy v1 (HMAC-signed, not encrypted) codes are **rejected** since 1.0 — complete any rolling deploy before upgrading past 0.4.x |
| An upstream API's error body leaking into the model or the audit log via `apiTool` | Default is status-only — the upstream response body is never forwarded on a non-2xx result, since it's a return value `onToolError` redaction never sees. Use `onError` for (a redacted version of) the body |
| `/authorize` errors delivered as a bare JSON body a connector can't act on | RFC 6749 §4.1.2.1: once `redirect_uri` is validated, every remaining error (`unsupported_response_type`, PKCE, `invalid_scope`, `invalid_target`, …) redirects to the client's own callback with `?error=…&state=…` instead. `redirect_uri` validity itself, and an oversized `state`, stay direct JSON — the URI is what's in question in the first case, and reflecting an oversized `state` into its own error redirect would recreate the DoS the length cap exists to prevent |
| DCR-issued `client_id` reused with a substituted `redirect_uri` | `/register` no longer returns a bare random id — the `client_id` **is** a sealed, self-verifying assertion of the exact `redirect_uris` it registered (`sealed.ts`, type `"client"`), with zero server-side storage. `/authorize` unseals it and binds the request to that list, the same protection a stored registration would give. This does not require the *identity* of the client to be verified — an attacker can still call `/register` and mint their own sealed id — so it stops URI substitution on a legitimate connector's id, not impersonation; the consent step above is what stops impersonation. `requireRegisteredClients` defaults to **true** since 1.0 (reject any `client_id` that isn't `clientStore`-resolved or self-sealed); set `false` only to accept invented public ids. Enforced at `/authorize`, and — since 1.2.0 — at `/token`'s `refresh_token` grant and at `/revoke` too, closing a gap where an invented `client_id` that never went through `/authorize` could still authenticate on either (the `authorization_code` grant was never actually exposed by this: a redeemable code's `client_id` is bound into its sealed payload at `/authorize` time, where the check already ran). Opt into CIMD with `cimd: true` for URL-shaped client_ids (off by default) |
| CIMD fetch as SSRF proxy (attacker supplies `https://…` `client_id`) | **Off by default** (`cimd: true` to enable). When on: HTTPS-only fetch, private/loopback/link-local/NAT64/`::ffff:` blocked (incl. bracketed IPv6), DNS lookup required before fetch and re-checked after the body, 5 KB stream-capped body / 10 s per hop covering the body read / 3 same-origin redirects (cross-origin redirects rejected), public clients only, `http:` redirect_uris loopback-only (`127.0.0.1` / `[::1]`, never `localhost`). Also blocked: `192.0.0/24`, `198.18/15`, multicast/reserved `224/4`–`240/4`, IPv6 multicast `ff00::/8`, 6to4 `2002::/16`, IPv4-compatible `::a.b.c.d`. `/token` and `/revoke` **re-resolve** CIMD — never accept URL-shaped ids by shape alone; pass `cimdCache` (strongly recommended) or every refresh/revoke re-fetches the document, and a failed re-resolve is audited as `cimd_resolve_failed`. **Ceiling:** TCP connect is not pinned to the looked-up addresses (zero-dep Web `fetch`); classic DNS rebinding between lookup and connect remains possible until a custom dispatcher pins the IP |
| Naming only confidential clients doesn't actually block public ones | `clients: ["gemini"]` (or `allowUnregisteredClients: false`) is **enforced**: DCR unmounted, dropped from AS metadata, unresolved `client_id` rejected with `unauthorized_client` at `authorize` and `invalid_client` at `token` and `revoke` |
| DCR / token-endpoint abuse | Edge or reverse-proxy rate limiting on `/register` and `/token`, **plus** a library-enforced request body cap (see "Also designed in") — the library does not rate-limit by request count, but an unbounded body was previously a memory-exhaustion vector on its own regardless of rate |
| A weak or copy-pasted `codeSecret` (it can forge an auth code — or, since 0.3.0, a consent ticket or DCR client assertion — for any userId/scope/resource) | Validated at the point of use: a string or array form throws at `createOAuthRouter` construction (every array entry checked, and the array itself must be non-empty), a function form on every call. Minimum 32 characters per entry, and the exact literals this package's own docs and examples have published are denylisted by name, as is any secret containing the examples' `do-not-reuse` marker — copy-paste is the realistic failure mode. The examples themselves read `OAUTH_CODE_SECRET` / `ACCESS_TOKEN_SECRET` from the environment and ship no usable default, and a test fails if any `codeSecret` literal in `examples/`, `README.md` or `docs/` is one the library would accept. This only catches the obvious cases; a leaked or brute-forceable 32+ character secret is still a full bypass, same as before |
| An operator unable to diagnose *why* a client was rejected, once `/token`/`/revoke` collapsed every failure to one generic `invalid_client` (see the enumeration-oracle row above) | `OAuthPorts.audit` (and `McpAppAuth.audit` on `createMcpApp`) — opt-in, sees the real reason (`"client requires client_secret_basic, got none"`, a rejected `codeSecret`'s actual message, …) that never reaches the caller. Same "never fails the request" guarantee as the MCP-side `audit` port |
| A hanging `ports.audit` sink stalling every audited response indefinitely | `auditTimeoutMs` (default 1000ms) on both `McpHandlerOptions` and `OAuthRouterOptions` races the audit call against a timeout; "can't fail a request" already held, this adds "can't delay one" past a bound. A slow sink keeps running in the background and its own internal `catch` means it can never surface as an unhandled rejection later |

**Also designed in:** PKCE S256 (timing-safe, length-capped; `code_challenge` must be a 43-character base64url digest at `/authorize`); auth codes, consent tickets, and DCR client assertions are all AES-GCM sealed with domain-separated keys (`sealed.ts`) so none of the three token types can be presented as another, and each binds `userId`/`clientId`/`redirectUri`/challenge/`resource` as applicable; redirect allowlist + DCR filter; a `redirect_uri` carrying a fragment or embedded credentials is rejected outright; no query-string tokens (`token` and `access_token`); honest `grant_types_supported`; `/token` and `/revoke` omit CORS `*` and both accept JSON or form bodies; request bodies are capped (1 MiB on `/mcp`, 64 KiB on `/token`/`/revoke`/`/register`) and a chunked body with no declared length is aborted mid-stream past the cap, not buffered first; audit fires on auth/scope denial as well as tool results; a scope-missing `tools/call` from an authenticated principal is **403** `insufficient_scope` (RFC 6750 §3.1), not a 401 that would just send the client back through the same authorize flow forever; 401/403 responses echo the real JSON-RPC request id instead of hardcoding `null`; `createOAuthRouter` refuses to construct if `oauthPath` and `resourcePath` would collide, or if `resourcePath` starts with `/.well-known`; `resourcePath` is normalized once at construction (`normalizeConfiguredPath`) so a trailing slash can't make `/authorize`, `/token`, and route matching disagree with each other about what the canonical resource is.

**Known limits:** in-memory jti map is process-local (multi-instance needs `codeStore`); the loopback redirect allowlist permits any path or port on `127.0.0.1`/`[::1]` over `http:` only — `localhost` and `https:` loopback are deliberately not accepted (RFC 8252 §8.3: `localhost` is DNS-resolvable, not a loopback guarantee, and native-app loopback redirects are `http:` only); DCR binds a client to its own `redirect_uris` via a sealed assertion but does not verify the *registrant's identity* (opt into CIMD with `cimd: true`); CIMD DNS checks do not pin the TCP connect (see CIMD SSRF row).

## Rotating codeSecret

`codeSecret` is the one secret behind auth codes, consent tickets, DCR
client assertions, and (when `clientStore.secretHash` is used)
confidential-client secret hashes. Before 1.2.0 it was a single string —
rotating it invalidated every DCR-issued `client_id` still in a connector's
hands and every stored `secretHash`, with no way to phase the change in.

Since 1.2.0, `codeSecret` also accepts an array:

```ts
codeSecret: [newSecret, oldSecret],
```

- The **first** entry is the one used to seal new auth codes, consent
  tickets, and DCR client assertions, and to hash a client secret passed to
  `hashClientSecret`.
- **Every** entry is tried, in order, when unsealing or verifying existing
  material — so a DCR `client_id` sealed under `oldSecret`, or a
  `secretHash` computed with it, keeps working.

To rotate:

1. Deploy with `codeSecret: [newSecret, oldSecret]`.
2. Watch `ports.audit` for `{ event: "legacy_code_secret_used", reason }` —
   it fires whenever anything but the first entry is the one that actually
   verified (a `client` assertion, `code`, `consent` ticket, or
   `client_secret_hash`, named in `reason`). Once it stops firing for a
   given `reason`, nothing still depends on `oldSecret` for that purpose.
3. Drop `oldSecret`: `codeSecret: newSecret` (or `[newSecret]`).

A DCR `client_id` is only as durable as the key it was sealed with — once
you drop a key, every `client_id` sealed under it (and only it) stops
authorizing, and the connector must re-register. `client_secret_hash`
entries you control the storage for: re-hash them under the new primary key
(`hashClientSecret(secret, newSecret)`) before dropping the old one, rather
than waiting for the audit event, if you want zero downtime for confidential
clients. Auth codes and consent tickets are short-lived (10 and 5 minutes
respectively) and need no such care — anything issued before rotation has
long expired by the time you'd reasonably drop a key.

`hashClientSecret` itself is unchanged: call it once, at registration time,
with whichever `codeSecret` value is currently primary.

## Not in scope

Explicitly **out** of this package (do not expect parity with full MCP hosts or enterprise AS products):

- **Tools only** — no `resources/*`, no `prompts/*`, and capabilities advertise tools alone
- **No server-initiated messages** — Streamable HTTP is served as a single JSON response per POST (which the spec permits, and which Gemini Enterprise requires). No SSE response streams, so no `notifications/progress` and no long-running tool keepalive
- **No sessions** — removed from the protocol in `2026-07-28` anyway
- **No enterprise-managed auth** — no ID-JAG, no IdP product integration; you wire login + minting
- **No login UI, no token store, no sessions** — the consent/approval screen at `/authorize` *is* shipped (built in, overridable via `consent.render`), because it's a security control determined entirely by protocol data the library already holds (`client_id`, `scope`, `redirect_uri`, `resource`), not by your IdP or branding. Login is the boundary: who the user is, and how they prove it, stays yours
- **No stdio** transport; no batch JSON-RPC arrays
- **No DPoP, PAR, or `client_credentials`** — this AS is authorization_code (+ optional refresh and revoke)
- **No rate limiting** — put quotas on `/register` and `/token` at the edge or reverse proxy
- **No paid external security audit** claimed here — see Threat model above

See [ROADMAP.md](ROADMAP.md) for what is next — the `2026-07-28` stateless core is the open protocol item; CIMD is shipped.
