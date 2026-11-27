# Security

Protocol promises, the library's threat model and what is out of scope.
Ports and audience wiring: [guide.md](guide.md).

## Protocol promises

- Notifications answer HTTP **202** with an empty body.
- Batch arrays answer `-32600`.
- `initialize` negotiates the protocol version. An unrecognized or missing version gets the newest supported one.
- `jsonrpc` must be exactly `"2.0"` on every `/mcp` request, else `-32600` (the request id is echoed when present).
- `MCP-Protocol-Version` is checked on every request after `initialize`. An unsupported value answers 400. A missing one is treated as `2025-03-26`.
- Query-string tokens (`token`, `access_token`) are rejected.
- `tools/call` checks `principal.scopes`. The scope `*` passes **every** tool scope check: keep it for trusted internal principals and never mint it for an external connector.
- With `createMcpApp`, a token whose audience is not this server's canonical resource is rejected.
- `fetch` never rejects. If a port you supply (`authenticate`, `context`, `resolveUser`, `mintAccessToken`, `clientStore`, ...) throws, `createMcpHandler`, `createOAuthRouter` and `createMcpApp` return a `500` (`-32603` for MCP, `server_error` for OAuth). The one exception is `AccessDeniedError` from `mintAccessToken` or `refreshAccessToken`, which answers `400 invalid_grant`. `asNodeHandler` catches independently.

## Threat model (library)

This is the library's own threat model, not a third-party audit. None has been done.

| Risk | Mitigation |
|------|------------|
| A logged-in user visits an attacker's page and is walked through `/authorize`, sending the code to an attacker-controlled `redirect_uri` | `/authorize` never issues a code directly. It renders a consent page (the built-in one sends CSP, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` and escapes what it shows; or your own through `consent.render`). A code is issued only after an explicit `POST ${oauthPath}/consent`. The ticket is sealed (AES-GCM, a key per token type), single use, valid 5 minutes, and re-checked against the resolved user. PKCE does not defend against this: it proves possession of the verifier, not that the client is legitimate. `preApprovedClientIds` skips the page only for ids `clientStore` resolves. The built-in page's `form-action` allows `'self'` plus the `redirect_uri` origin (its scheme for a custom-scheme URI); a custom `consent.render` that sets its own CSP must do the same, or Chromium blocks the redirect back to the client |
| Token used at the wrong MCP server | RFC 8707: `resource` is required at authorize and token, bound into the auth code, and must equal `canonicalResource(origin, resourcePath)`. It is passed to `mintAccessToken` and `refreshAccessToken` so you can embed `aud` |
| Refresh token replayed at another resource | The library cannot read opaque refresh tokens. **`refreshAccessToken` must reject tokens not issued for the given `resource`** |
| Audience not enforced at the resource server | `createMcpApp` rejects any `verifyToken` audience that differs from the canonical resource. With bare `createMcpHandler`, the check is yours |
| Open redirect after login | Your login page must check that `next` is same-origin |
| Auth-code replay across instances | Pass a shared `codeStore`. The process-local store is for one process |
| Origin spoofing on Node | Pass an explicit `origin`, or `trustProxy: true` only behind a proxy that strips client `X-Forwarded-*`. A Host-derived origin needs a non-empty `allowedOrigins` (`["*"]` to opt out). A fixed `origin` ignores `Host`, so for a loopback `origin` `asNodeHandler` rejects any other `Host` by default, and `allowedHosts` does the same for any origin |
| A Host or `X-Forwarded-*` header with a path, query, fragment or credentials | `resolveOrigin` validates through `URL` and throws `InvalidOriginError` (also for a non-`http(s)` `X-Forwarded-Proto`). `asNodeHandler` answers 400 |
| Browser `Origin` on MCP (DNS rebinding, CSRF) | `allowedRequestOrigins`. No `Origin` header: allowed (native clients). Omitted allowlist: any present `Origin` is rejected with 403. `"*"` opts out. Not the same as `allowedOrigins` on `asNodeHandler` |
| Scope escalation at authorize | The requested `scope` is checked against the advertised `scopes` (`invalid_scope`), bound into the auth code and passed to `mintAccessToken` |
| A tool, resource or skill without `scope` is usable by any principal, even one holding none of the advertised scopes | With more than one advertised scope, `createMcpApp` refuses to construct if one omits `scope`. Pass `scope: null` to say so on purpose. `tools/call` always enforces the scope a tool declares (403 `insufficient_scope`) |
| Scope reduction lost on refresh | An optional `scope` on the refresh request is checked against the advertised scopes and passed in `RefreshAccessTokenInput.scope`. **`refreshAccessToken` must keep it within the originally granted scopes.** The response omits `scope` when neither the port nor the grant supplies one (RFC 6749 §5.1) |
| A removed or disabled user keeps a working connector | `signedTokenAuth` tokens are stateless and outlive the login session. `isUserActive` closes that: [Sessions and expiry](#sessions-and-expiry) |
| Stolen access or refresh token | Implement `revokeToken` with a denylist (or equivalent) that `verifyToken` and `refreshAccessToken` consult. Unknown or wrong-client tokens must no-op, not throw. A well-formed authenticated revoke answers 200 even for an unknown token |
| Stolen confidential-client secret | Store hashes, not plaintext. Prefer `clientStore.secretHash` (a value from `hashClientSecret`): the library compares in constant time, so there is no hand-written `stored === presented` timing leak. The library never stores credentials |
| Enumerating known `client_id`s through `/token` or `/revoke` errors or timing | Every client-auth failure answers one `invalid_client` ("client authentication failed"). Each rejection for a known client, and for an unknown id on a locked-down server, runs the same fixed-cost comparison, so timing does not tell them apart. `/authorize` keeps its descriptive `unauthorized_client`: it serves a human in a browser, and a locked-down server already omits `registration_endpoint` |
| Auth codes readable from browser history, `Referer` or proxy logs | Auth codes are sealed (AES-GCM), not just signed. Consent tickets and DCR client assertions are sealed with separate keys, so none of the three can be used as another |
| An upstream error body reaching the model or audit log through `apiTool` | A non-2xx result carries the status only. Use `onError` to forward a redacted body |
| `apiTool` as a credential-forwarding or SSRF primitive through redirects | Redirects are not followed (`redirect: "manual"`). `"follow"` is an opt-in for a fully trusted upstream |
| A small tool call amplified into a huge validation error | Validation stops after 20 violations and the message is capped at 2000 characters. Audit copies of tool errors are capped at 1000 |
| `/authorize` errors as a bare JSON body a connector cannot act on | Once `redirect_uri` is valid, errors redirect to it with `?error=...&state=...` (RFC 6749 §4.1.2.1). An invalid `redirect_uri` and an oversized `state` answer 400 directly: the first is what is in question, and reflecting an oversized `state` would recreate the header-size DoS the cap prevents |
| A DCR `client_id` reused with a substituted `redirect_uri` | `/register` returns a `client_id` that is a sealed assertion of the exact `redirect_uris` it registered, with no server-side storage. `/authorize` binds the request to that list. This stops URI substitution on a legitimate id, not impersonation: anyone can register their own. The consent page is what stops impersonation. `requireRegisteredClients` (default `true`) rejects any `client_id` not resolved by `clientStore` or issued by `/register`, at `/authorize`, the `refresh_token` grant and `/revoke`. `cimd: true` adds URL-shaped client ids |
| CIMD fetch as an SSRF proxy (an attacker supplies an `https://...` `client_id`) | Off by default (`cimd: true`). When on: HTTPS only. Private, loopback, link-local, NAT64, `::ffff:` mapped (all encodings), `192.0.0/24`, `198.18/15`, multicast and reserved IPv4 (`224/4` to `240/4`), IPv6 multicast, 6to4 and IPv4-compatible addresses are blocked. DNS is resolved before the fetch and again after the body, and an unparseable IPv6 result fails closed. Limits: 5 KB body, 10 s per hop (covering the body read), 3 same-origin redirects (cross-origin redirects are refused). Public clients only; `http:` redirect URIs must be `127.0.0.1` or `[::1]`. A `client_id` over 2048 characters is not a CIMD id. `/token` and `/revoke` re-resolve the document; pass a bounded `cimdCache`, or each refresh and revoke re-fetches it (a document stays cached up to an hour, and a failing `cimdCache.get` counts as a miss). A failed resolve is audited as `cimd_resolve_failed` at `/authorize`, `/token` and `/revoke` with a reason code (never an address, header, body or redirect target), while the connector gets one generic `unauthorized_client`. The default resolver uses `resolve4` and `resolve6` (c-ares), not `getaddrinfo`, so unresolvable hosts cannot starve the thread pool WebCrypto shares: 5 s per lookup, at most 8 at once, the rest fail with `dns_failed`. It reads `/etc/resolv.conf` and ignores the hosts file and system or VPN resolver settings; pass `cimdLookup` for your own. **Ceiling:** the TCP connection is not pinned to the checked address, so DNS rebinding between lookup and connect is possible with the default `fetch`. Pass `cimdFetch` on Node to close it, and do not treat CIMD as a complete SSRF defense without it. `cimdAllowedPorts` and `cimdRequireJsonContentType` narrow what is fetched: [Restrictive profile](#restrictive-profile) |
| Naming only confidential clients does not block public ones | `clients: ["gemini"]` (or `allowUnregisteredClients: false`) is enforced: DCR is unmounted and dropped from metadata, and an unresolved `client_id` is rejected (`unauthorized_client` at authorize, `invalid_client` at token and revoke) |
| DCR and token-endpoint abuse | The library caps request bodies (`/mcp` 1 MiB, `/token`, `/revoke` and `/register` 64 KiB; a chunked body without a length is aborted mid-stream) but does not rate-limit. Rate-limit `/register` and `/token` at the edge, and `/authorize` when `cimd: true` (each unresolvable `client_id` costs an outbound fetch and an audit entry). With an `audit` sink, every refused `/register` and every refused protocol version header also writes an entry before any authentication, so the same edge limit protects the sink |
| A weak or copy-pasted `codeSecret` (it can forge an auth code, consent ticket or DCR assertion for any user, scope and resource) | Checked at the point of use: at `createOAuthRouter` construction for a string or array (each entry, and the array must be non-empty), on every call for a function. A secret under 32 characters, or containing `do-not-reuse` (the marker in every published example), is refused. The examples read `MCP_SECRET` or `OAUTH_CODE_SECRET` from the environment and ship no default, and a test fails if a `codeSecret` literal in `examples/`, `README.md` or `docs/` would be accepted. A leaked or guessable 32-character secret is still a full bypass |
| An operator cannot tell why a client was rejected | `OAuthPorts.audit` (`McpAppAuth.audit` on `createMcpApp`) receives the real reason that never reaches the caller. It never fails the request |
| A hanging `ports.audit` sink stalls responses | `auditTimeoutMs` (default 1000 ms), on the MCP handler and the OAuth router, caps the wait. The slow sink keeps running and cannot surface as an unhandled rejection |

**Also built in:** PKCE S256 only (timing-safe; `code_challenge` must be a 43-character base64url digest); every sealed value binds `userId`, `clientId`, `redirectUri`, challenge and `resource` as applicable; a `redirect_uri` with a fragment or credentials is rejected; `/token` and `/revoke` send no CORS `*`; a request without the tool's scope is 403 `insufficient_scope` (RFC 6750 §3.1), not a 401 that would loop the client through authorize; 401 and 403 echo the real request id; `createOAuthRouter` refuses to construct when `oauthPath` equals `resourcePath` or `resourcePath` starts with `/.well-known`, and normalizes `resourcePath` once so a trailing slash cannot split the canonical resource.

**Known limits:**

- The process-local single-use store works for one instance only. Use `codeStore` for more.
- The loopback allowlist accepts any path or port on `127.0.0.1` and `[::1]` over `http:`. `localhost` and `https:` loopback are refused (RFC 8252 §8.3).
- DCR binds a client to its own `redirect_uris` but does not verify who registered. CIMD clients bring their own redirect URIs.
- At `/token`, an auth code is spent before the client, redirect and PKCE checks. Someone holding a stolen code can burn it, which costs that one login. PKCE still blocks redemption, and the order limits a thief to one verifier guess per code.
- The built-in consent page shows a CIMD client's own name as "name not verified". Its guard against names that imitate a vendor catches common look-alikes only.
- `clients` selects compatibility presets. It does not restrict who can register (set `allowLoopback: false` to narrow it).
- `/register` drops redirect URIs the policy rejects and answers `201` with the accepted subset. That `redirect_uris` list is the one the `client_id` is bound to. If none pass, it answers `invalid_redirect_uri`.

## Tenant isolation: what Trellis does and what the application does

Trellis decides **who may call what**. Your application decides **whose data a call returns**. They meet at the `context` port.

| Trellis does | Your application does |
|---|---|
| Authenticates the bearer through your `authenticate` or `verifyToken`, and with `createMcpApp` refuses a token whose audience is not this server | Decides what `principal.id`, `scopes` and `claims` mean, and keeps them current (for example `isUserActive`) |
| Checks the tool's `scope` on every `tools/call`; with `hideToolsOutsideScope` also lists only the tools the caller may use | Chooses scopes that match capabilities. A scope is not a data partition: `read` says nothing about which rows |
| Builds `context(req, principal)` once per call that will run, never from tool arguments | Derives the tenant in `context` from `principal` (its `claims`), never from `arguments`, and applies it in every query |
| Passes arguments through as sent, after schema validation | Treats `arguments` as untrusted: a tenant id in them is the caller's claim, not a fact |
| Audits the principal and the tool for every call and denial | Redacts tenant data from tool error text with `onToolError`: it reaches the audit entry, clipped to 1000 characters |
| Marks every response `Cache-Control: no-store` and every cache hint on an authenticated 2026-07-28 result `private` | Keeps its own caches keyed by tenant, and never serves one tenant's cached result to another |

If a tool reads data without the tenant from `context`, no Trellis setting makes it safe. `test/security/` plays two tenants against the library's own layers; it cannot test your data layer.

### Caches and shared state

Every place the library keeps something between requests, and what keeps it from crossing callers.

| Where | Holds | Keyed by | Crossing callers |
|---|---|---|---|
| HTTP responses | Nothing: `Cache-Control: no-store` on every MCP and OAuth response | not applicable | A shared cache must not store them. Pinned by `test/security/cache-malformed.test.ts` |
| 2026-07-28 cache hints | `ttlMs: 0` and `cacheScope: "private"` on `tools/list`, `resources/list`, `resources/read`, `skills/list`, `skills/get` | not applicable | Never `public` behind authentication. `server/discover` is `public` only when anonymous, and holds static server data |
| Key cache (`hkdf.ts`) | Keys derived from `codeSecret` | A SHA-256 fingerprint of the secret | No user data |
| `processCodeStore` (`codes.ts`) | Single-use marks for auth codes and refresh tokens | The token's `jti` | Process-local. Pass a shared `codeStore` for more than one instance |
| `cimdCache` (host-supplied) | Public client metadata documents | The `client_id` URL | Public data, but a changed `redirect_uris` stays valid until the entry expires (at most an hour) |
| Resource catalog | The `ui://` documents, the `resources` and the skill files, built once per server | URI | Read-only. `read(ctx)` of a general resource runs once per authorized read and is never cached |
| Skill manifest (`skills/compile.ts`) | `sha256` digests and sizes of each skill's static text, hashed on first use | Skill | The same for every caller. A failed hash is retried, not kept |

A client that caches results itself must key its cache by credential or principal. The library cannot enforce that.

### Restrictive profile

For a server where even the existence of a tool or a client document must not leak. Each option is opt-in and off by default.

- `hideToolsOutsideScope: "strict"`: `tools/list` omits tools the caller may not use, and a `tools/call` for one answers as an unknown tool (`-32602`), like a name that does not exist. The denial is still audited as `missing_scope`. `true` hides the same way but keeps the `403 insufficient_scope` answer, which names the scope and so confirms the tool exists.
- `cimd: true` with a bounded `cimdCache`, `cimdAllowedPorts: [443]` and `cimdRequireJsonContentType: true`.
- `cimdFetch`: on Node, a fetch that connects only to an address that passed the check, to close DNS rebinding. It must honour `redirect: "manual"`; a response that followed a redirect is refused. Without it, the check runs before the request and again after the body, so a resolver that changes its answer can cause one blind request.
- `isUserActive`, a short `ttlSeconds`, and `allowedRequestOrigins` set to your known origins.

### Tool schemas, results and UI documents

| Risk | What the library does |
|------|-----------------------|
| A `pattern` in a tool schema hangs the server (ReDoS) | `pattern` and `patternProperties` run on a built-in non-backtracking matcher (linear in input length times program size), not on `RegExp`, so there is no catastrophic case and no heuristic to bypass. Bounds: source 512 characters, program 2000 instructions, group depth 32, string 4096 code units (worst accepted program: 49 ms). Each match is charged to the validation step budget, so many strings or keys end in a rejection. Backreferences, lookaround and `\p{...}` are refused at construction; use a `schemaValidator` for them. [Details](reference.md#json-schema-2020-12) |
| A schema or a value built to exhaust CPU or memory | Depth, subschema count, recursion, `$ref` hops, work units and `uniqueItems` size are bounded. Over a bound at construction throws; while validating, the call is rejected, never passed. `$ref` is local only and is never fetched |
| A result leaks data through its validation error | A result that breaks `outputSchema` is replaced by "Tool returned an invalid result". The client sees neither the data nor the violations. `onOutputViolation` receives them and they can hold the data: log them on the server only |
| A `schemaValidator` that throws or misbehaves | It fails closed: "Invalid arguments" or "Tool returned an invalid result", and the thrown message is not shown. It also replaces the construction checks, so you vet the schemas |
| `annotations` taken as access control | They are hints that clients must treat as untrusted, and the library never reads them to authorize a call. Enforce access with `scope`, `allow` and `context` |
| An intermediary routes on `Mcp-Param-*` headers while the handler sees a different value | On a 2026-07-28 `tools/call`, an annotated header that differs from the body answers `-32020` before the handler runs, with fixed text and no value echoed. The Node adapter rejects a repeated header; a host that builds its own `Request` must too. Integers must be canonical (`42` or `42.0`, not `+42`, `042`, `-0`) and a base64 value keeps a leading BOM. The browser preflight lists every annotated `Mcp-Param-*` name, so those names are visible to anonymous callers. This is a consistency check, not authentication |
| A UI document asks for more than it needs | `csp` origins, `permissions` (only `camera`, `microphone`, `geolocation`, `clipboardWrite`, each `{}`) and `blob` size (16 MiB decoded) are checked at construction. The host decides what to grant. A 2026-07-28 client that did not declare MCP Apps never sees `ui://` documents. See [mcp-apps.md](mcp-apps.md) |

## Sessions and expiry

The connector holds a token, never the app's login cookie. What each event does to it, with `signedTokenAuth`:

| Event | What the connector sees |
|-------|-------------------------|
| The app session ends (cookie expires, logout) | Nothing. The next `/authorize` redirects to `loginUrl`. A token already issued keeps working |
| The access token reaches its `ttlSeconds` (default 1 hour) | `401` with `WWW-Authenticate: Bearer ..., error="invalid_token"` (one code for a bad signature, expiry, wrong audience or an inactive user). With a refresh token the client renews silently. Without one, the user goes through the browser again |
| The user is removed, disabled or signed out everywhere | With `isUserActive`: `401` on the next MCP request, `invalid_grant` on the next refresh. Without it, the access token works until it expires. `isUserActive` runs on every request, only `true` passes, and a throw is a `500`. Keep it cheap or cached: a call that hangs stalls the request |
| The user's role or scopes change | The token keeps the scopes granted at issue until it expires. Enforce current permissions in the data layer |
| The user waits on the consent page over 5 minutes, the session ends before Approve, or Approve is posted twice | A short page in the browser (JSON for a caller that does not ask for `text/html`), status `400`. `consent.render` customizes the consent screen only |
| `secret` becomes a list `[new, old]` | Old tokens and DCR `client_id`s keep working. New ones are signed with `new`. Remove `old` once its tokens have expired; until then it can still forge |
| `initialize` and `ping` | Succeed with no token or a bad one, so a "connected" status proves nothing. A `GET /mcp` with an `Authorization` header answers `405` without checking it. Other methods check the token |

Access tokens are bearer tokens: not bound to a client and not revocable before they expire, so keep `ttlSeconds` short.

### Production auth profile

For data that must stop being reachable when access is withdrawn:

- Pass `isUserActive`. It runs on every MCP request, so a blocked user gets `401` on the next call. Back it with a cache of a few seconds.
- Keep `ttlSeconds` short, for example 300, and set `refreshTtlSeconds` so a connector renews without sending the user back to the browser.
- To revoke one token or a token family at once, `signedTokenAuth` cannot. Implement `verifyToken` and `refreshAccessToken` over your own store (`examples/project-desk/src/tokens.ts`).
- Rate-limit `/register` and `/token` at the edge (see [Not in scope](#not-in-scope)).

**Refresh (`refreshTtlSeconds`).** Off unless set. Refresh tokens are signed, not stored. The only state is a single-use mark per token in `codeStore`.

- **Lifetime.** Absolute: fixed when the authorization code is redeemed and never extended by refreshing. The user approves again after `refreshTtlSeconds`. The last access token can run up to `ttlSeconds` past that.
- **Single use.** Each refresh token works once and is replaced. `codeStore.consume` must be atomic (Redis `SET NX EX`, a unique-key insert) with a TTL no shorter than the token. The process-local store does not hold across instances, and Workers KV is not atomic, so neither gives single use. Pass the same `codeStore` to `signedTokenAuth` as to the router; it refuses to start without one. One mark per refresh stays until the grant expires, so size the store and rate-limit `/token` per `client_id`.
- **Binding.** To the user, client, resource and scopes of the consent. A refresh may narrow scope, never widen it. Narrowing applies to that one access token: the next refresh token keeps the original scopes (RFC 6749 §6). Every failure is one `invalid_grant`, and every check that depends on caller input runs before the token is burned, so a wrong client cannot spend the rightful holder's token.
- **Size.** A refresh token is capped at 4096 characters. Issuing a longer one (a user id of roughly 2.8 KB, or a very long scope list) throws: at first issuance that is a `500` at `/token` after the authorization code was spent, on every login for that user. Keep user ids short.
- **No grace window.** A client that loses a refresh response and retries is logged out and must re-authorize, as it is if minting fails after the old token was burned.
- **No token family.** Replaying a used token is refused, but the successor a thief obtained first stays valid until it expires or `isUserActive` turns false. For family revocation, use an opaque server-side store (`examples/project-desk/src/tokens.ts`).
- **`/revoke`** burns a refresh token only and answers `200` for anything else, including an access token. A store failure on a valid refresh token is a `500`, so revoking the current refresh token never reports success while it still works. Revoking one already replaced by a refresh is a no-op: it answers `200` and the successor keeps working.

## Rotating codeSecret

`codeSecret` is the one secret behind auth codes, consent tickets, DCR client assertions and (with `clientStore.secretHash`) confidential-client secret hashes. It accepts an array:

```ts
codeSecret: [newSecret, oldSecret],
```

- The **first** entry seals new auth codes, consent tickets and DCR client assertions, and hashes a client secret passed to `hashClientSecret`.
- **Every** entry is tried, in order, when unsealing or verifying, so a DCR `client_id` sealed under `oldSecret`, or a `secretHash` computed with it, keeps working.

To rotate:

1. Deploy with `codeSecret: [newSecret, oldSecret]`.
2. Watch `ports.audit` for `{ event: "legacy_code_secret_used", reason }`. It fires when an entry other than the first verified something. `reason` is `<what> with codeSecret[<index>]`, where `<what>` is `client assertion unsealed`, `auth code redeemed`, `consent ticket unsealed` or `client_secret_hash verified`. When a `<what>` stops appearing, nothing depends on `oldSecret` for it.
3. Drop `oldSecret`: `codeSecret: newSecret` (or `[newSecret]`).

A DCR `client_id` is only as durable as the key that sealed it: once you drop a key, every `client_id` sealed under it stops authorizing and the connector must register again. You control the storage of `client_secret_hash` values, so re-hash them under the new primary key (`hashClientSecret(secret, newSecret)`) before dropping the old one if confidential clients must not see downtime. Auth codes (10 minutes) and consent tickets (5 minutes) expire on their own.

Call `hashClientSecret` once, at registration time, with the current primary `codeSecret`.

## Not in scope

Out of this package. Do not expect parity with full MCP hosts or enterprise authorization servers.

- **No `prompts/*`, resource templates, subscriptions or completion.** `resources/*` serves the `ui://` documents of MCP Apps, the fixed-URI `resources` and the experimental `skills` you register, each only to a principal its `scope` and `allow` admit. What a resource's `read(ctx)` returns is your code: apply the tenant from `context` there, as in a tool.
- **No server-initiated messages.** Each POST gets one JSON response (which the spec permits). No SSE streams, so no `notifications/progress` and no keepalive for long tool calls.
- **No sessions.**
- **No enterprise-managed auth.** No ID-JAG, no IdP integration: you wire login and minting.
- **No login UI, token store or sessions.** The consent screen at `/authorize` is shipped (built in, overridable through `consent.render`) because it is a security control decided entirely by protocol data the library holds (`client_id`, `scope`, `redirect_uri`, `resource`). Login stays yours: who the user is and how they prove it.
- **No stdio transport and no batch JSON-RPC arrays.**
- **No DPoP, PAR or `client_credentials`.** The server supports `authorization_code`, plus optional refresh and revoke.
- **No rate limiting.** Put quotas on `/register` and `/token` at the edge or reverse proxy.
- **No timeout on your ports.** `resolveUser`, `mintAccessToken`, `verifyToken`, `refreshAccessToken` and `codeStore.consume` are awaited without a deadline, and a tool handler receives no `AbortSignal`. Set timeouts on the clients behind them (database, Redis, HTTP). Only the audit sink, the CIMD fetch and `apiTool` calls are time-bounded by the library.
