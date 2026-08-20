# Security

Protocol promises, library threat model, and explicit non-goals.
Ports and audience wiring: [guide.md](guide.md). Roadmap: [ROADMAP.md](ROADMAP.md).

## Protocol promises

- Notifications → HTTP **202** with an empty body
- Batch arrays → `-32600` (MCP 2025-06-18)
- Protocol version negotiated from client `initialize` params
- Query-string tokens rejected (`token` and RFC 6750 `access_token`)
- `tools/call` checks `principal.scopes` (`*` = all), and the OAuth grant that produced them is validated at `authorize`
- With `createMcpApp`, tokens whose audience is not this server's canonical resource are rejected by the library
- **`fetch` never rejects.** If a host port you supply (`authenticate`, `context`, `resolveUser`, `mintAccessToken`, `clientStore`, …) throws, `createMcpHandler`, `createOAuthRouter`, and `createMcpApp` all catch it and return a real `500` (`-32603` for MCP, `server_error` for OAuth) instead of an unhandled rejection — whose shape and whether it even reaches the client varies by runtime. `asNodeHandler` catches independently too, since on raw `http.createServer` a rejection there leaves the socket open with no response ever sent.

## Threat model (library)

This is a **library** threat model, not a third-party audit badge.

| Risk | Mitigation |
|------|------------|
| Confused deputy (token usable at the wrong MCP) | RFC 8707: `resource` required on authorize + token; bound into the auth code; must equal this AS's canonical resource (`canonicalResource(origin, resourcePath)`). Passed into `mintAccessToken` / `refreshAccessToken` so you can embed `aud`. |
| Refresh token replayed at another resource on the same AS | Library cannot inspect opaque refresh tokens — **`refreshAccessToken` MUST reject tokens not originally issued for the given `resource`** |
| Audience not enforced at the RS | **`createMcpApp` enforces this** — `verifyToken` returns the token's `audience` and the library rejects any mismatch against `canonicalResource(origin, resourcePath)`. With bare `createMcpHandler`, the check is yours. |
| Open redirect after login | Your login page must validate `next` is same-origin before redirecting |
| Auth-code replay across instances | Pass a shared `codeStore`; in-memory `jti` (the auth code's single-use id) map is process-local only |
| Origin spoofing on Node | Pass explicit `origin`, or `trustProxy: true` only behind a proxy that strips client `X-Forwarded-*`. Host-derived origin **requires** non-empty `allowedOrigins` on `asNodeHandler` (`["*"]` to opt out loudly) |
| Scope escalation at authorize | Requested `scope` is validated against the advertised `scopes` and rejected with `invalid_scope`; the grant is bound into the auth code and handed to `mintAccessToken` |
| Stolen access or refresh token | Host `revokeToken` (denylist or equivalent) that `verifyToken` and `refreshAccessToken` consult. Unknown / wrong-client tokens MUST no-op, not throw. Well-formed authenticated revoke is 200 even if the token is unknown |
| Stolen confidential-client secret | `clientStore.verifySecret` owns comparison — store hashes, not plaintext. The library never sees or persists credentials |
| Registration-free DCR | `/register` returns a random `client_id` that is **never stored**; any unknown `client_id` works with an allowlisted `redirect_uri`. Defensible for public clients with PKCE — the model dynamic connectors (Claude, Codex) actually need. Pre-registered clients bypass this entirely, bound to their own `redirectUris` and auth method. The IETF's Client ID Metadata Document (CIMD) draft replaces this model |
| Naming only confidential clients doesn't actually block public ones | `clients: ["gemini"]` (or `allowUnregisteredClients: false`) is **enforced**: DCR unmounted, dropped from AS metadata, unresolved `client_id` rejected with `unauthorized_client` at `authorize` and `invalid_client` at `token` and `revoke` |
| DCR / token-endpoint abuse | Edge or reverse-proxy rate limiting on `/register` and `/token`. The library does not rate-limit |

**Also designed in:** PKCE S256 (timing-safe, length-capped); HMAC auth codes bind `userId`, `clientId`, `redirectUri`, challenge, and `resource`; redirect allowlist + DCR filter; no query-string tokens (`token` and `access_token`); honest `grant_types_supported`; `/token` and `/revoke` omit CORS `*`; audit fires on auth/scope denial as well as tool results.

**Known limits:** in-memory jti map is process-local (multi-instance needs `codeStore`); loopback redirect allowlist permits any path/port on `localhost` / `127.0.0.1` (expected for native clients); DCR does not bind credentials to a stored client record until CIMD.

## Not in scope

Explicitly **out** of this package (do not expect parity with full MCP hosts or enterprise AS products):

- **Tools only** — no `resources/*`, no `prompts/*`, and capabilities advertise tools alone
- **No server-initiated messages** — Streamable HTTP is served as a single JSON response per POST (which the spec permits, and which Gemini Enterprise requires). No SSE response streams, so no `notifications/progress` and no long-running tool keepalive
- **No sessions** — removed from the protocol in `2026-07-28` anyway
- **No enterprise-managed auth** — no ID-JAG, no IdP product integration; you wire login + minting
- **No embedded product surface** — no token store, sessions, or login UI
- **No stdio** transport; no batch JSON-RPC arrays
- **No DPoP, PAR, or `client_credentials`** — this AS is authorization_code (+ optional refresh and revoke)
- **No rate limiting** — put quotas on `/register` and `/token` at the edge or reverse proxy
- **No paid external security audit** claimed here — see Threat model above

See [ROADMAP.md](ROADMAP.md) for what is next — CIMD and the `2026-07-28` stateless core are the two open items.
