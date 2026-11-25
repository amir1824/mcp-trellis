# Reference

Package surface, routes, MCP methods, status codes, options, and exports.
Ports and recipes: [guide.md](guide.md). Security: [security.md](security.md).

## Package surface

| Import | What you get |
|--------|----------------|
| `mcp-trellis` | `createMcpApp`, client profiles, MCP handler, tool registry, bearer helpers, JSON-RPC helpers |
| `mcp-trellis/oauth` | OAuth 2.1 AS router, discovery metadata, resource and redirect policy, client-secret hashing |
| `mcp-trellis/node` | `asNodeHandler` + `resolveOrigin` for Node `(req, res)` |
| `mcp-trellis/advanced` | Low-level primitives: PKCE, auth codes, client auth, scope/resource parsing, schema validation, HTTP utils. Less stable — may change in a minor release |

`createMcpApp` is the batteries-included layer. `createMcpHandler` and
`createOAuthRouter` remain exported and unchanged — reach for them when you want
to own the routing or mount the two halves separately. See
[compose the primitives](guide.md#advanced-compose-the-primitives).

## Default OAuth routes

With defaults `resourcePath: "/mcp"` and `oauthPath: "/mcp/oauth"`:

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-protected-resource` (+ `/mcp`) | Protected resource metadata |
| `/.well-known/oauth-authorization-server` (+ `/mcp`) | Authorization server metadata |
| `/mcp/oauth/register` | Dynamic client registration (unmounted when DCR is off). `redirect_uris`, if supplied, must be an array of at most 10 entries — a malformed body, a non-object body, a non-array `redirect_uris`, or too many entries all return **400** `invalid_client_metadata` (RFC 7591 §3.2.2) rather than silently falling back to the default callback. `redirect_uris` omitted entirely still falls back as documented below |
| `/mcp/oauth/authorize` | Authorization endpoint — GET only. Renders a consent interstitial rather than redirecting directly; see `/consent` below and [security.md](security.md). Once `redirect_uri` is validated, every remaining error redirects to it with `?error=…` (RFC 6749 §4.1.2.1) rather than returning JSON; an invalid `redirect_uri` itself, and an oversized `state`, are the two exceptions and stay direct 400s |
| `/mcp/oauth/consent` | POST only. Approves or denies a consent ticket issued by `/authorize` and, on approval, issues the code and redirects to `redirect_uri` |
| `/mcp/oauth/token` | Token endpoint. JSON or form body |
| `/mcp/oauth/revoke` | Token revocation (RFC 7009; mounted only when `revokeToken` is set). JSON or form body |

## Supported MCP methods

| Method | Auth | Notes |
|--------|------|-------|
| `initialize` | public | Negotiates protocol version; returns `capabilities.tools` |
| `ping` | public | Empty result |
| `tools/list` | Bearer | Lists registry entries |
| `tools/call` | Bearer + scope | Runs the tool; no Bearer at all → 401, authenticated but missing scope → 403, `params.name` naming no registered tool → `-32602` (protocol error, not a tool result — see `docs/guide.md`) |
| `resources/list`, `resources/read` | Bearer | Only when a UI or `resources` is configured (MCP Apps, see `docs/mcp-apps.md`; general resources, see `docs/resources.md`); otherwise `-32601`. `resources/templates/list`, `resources/subscribe` and `completion/complete` are never served (`-32601`) |
| `notifications/*` | public | HTTP 202 empty body |

Anything else → JSON-RPC `-32601`. Capabilities advertise **tools only**, plus `resources` when a UI or `resources` is configured.

## 2026-07-28 requests

A POST that carries `MCP-Protocol-Version: 2026-07-28` is a 2026-07-28 request. Every other request is handled exactly as before, except the one `-32022` case below. A 2026-07-28 request must also carry:

- `_meta` with `io.modelcontextprotocol/protocolVersion` (equal to the header) and `io.modelcontextprotocol/clientCapabilities` (an object), else `-32602` over HTTP 400, or `-32020` if the version differs from the header;
- `Mcp-Method` equal to the body's `method`, and for `tools/call` and `resources/read` an `Mcp-Name` equal to the tool name or resource URI (non-ASCII values use `=?base64?...?=`), else `-32020` over HTTP 400 before any method runs.

| Method | Auth | Result |
|--------|------|--------|
| `server/discover` | public by default | `supportedVersions`, `capabilities`, `_meta["io.modelcontextprotocol/serverInfo"]`, optional `instructions`; `cacheScope: "public"` whenever it is served without authentication (the default), `"private"` when the host requires authentication for it |
| `tools/list` | Bearer | as before, plus `resultType` and cache hints |
| `tools/call` | Bearer + scope | as before, plus `resultType` |
| `resources/list`, `resources/read` | Bearer | only when a UI or `resources` is configured; plus `resultType` and cache hints |

`initialize`, `ping` and any other method answer `404` with `-32601` (after authentication). Every success result carries `resultType: "complete"`. `tools/list`, `resources/list` and `resources/read` carry `ttlMs: 0` and `cacheScope: "private"`: anything served after authentication or a scope check is private, and the hints never replace the per-request scope check. Responses still send `Cache-Control: no-store`. A tool whose own name has the form `=?base64?...?=` cannot be called under this header, because that form is always decoded. A request whose `MCP-Protocol-Version` header and `_meta` protocol version both name the same version this server lacks gets `-32022` and the list it supports (never for `initialize`, which has always ignored the header); a request with an unknown header and no matching `_meta` keeps its older `-32600`. An oversized body under the 2026-07-28 header answers `-32600` over HTTP 413 (`-32002` is not used there), also through `asNodeHandler`.

### Migrating to 2026-07-28

Nothing is required. Existing clients and the three older protocol versions behave exactly as before (except the `-32022` case above, which only a client sending the 2026-07-28 `_meta` key can reach); the new behaviour starts only when a client sends the 2026-07-28 header. A host that set its own `publicMethods` and wants `server/discover` anonymous must add it. A browser client needs no change on your side: the preflight now also allows the `Mcp-Method` and `Mcp-Name` headers.

### Migrating to the CIMD hardening options

No change is required for an existing integration. `cimdFetch`, `cimdAllowedPorts`, `cimdRequireJsonContentType` and `hideToolsOutsideScope: "strict"` are optional and off by default, so a host that sets none of them gets the same answers as before. To opt in, follow the restrictive profile in [security.md](security.md#restrictive-profile). To go back, remove the option: nothing is stored.

### Migrating to resources

No change is required for an existing integration. Registering `resources` adds `resources/list` and `resources/read` and the `resources` capability; a client that never reads resources is unaffected. The audit `error` field can now be `resource_failed`; a host that switches exhaustively on it should handle the new value. Rollback: remove the option.

## HTTP and JSON-RPC status codes

| HTTP | When |
|------|------|
| **202** | Notification (empty body) |
| **400** | Parse error, batch array, invalid request, `jsonrpc` not `"2.0"`, unsupported `MCP-Protocol-Version` |
| **401** | Missing/invalid Bearer; includes `WWW-Authenticate`; echoes the real request id, not `null` |
| **403** | Authenticated, but the token's scopes don't include the tool's `scope`; `WWW-Authenticate` carries `error="insufficient_scope"` and `scope="<required>"` (RFC 6750 §3.1) |
| **404** | A 2026-07-28 request for a method this server does not implement (`-32601`) |
| **405** | Wrong HTTP verb on MCP |
| **413** | Request body over the cap — `/mcp` (1 MiB default), `/token`/`/revoke`/`/register` (64 KiB default) |

| JSON-RPC code | Constant |
|---------------|----------|
| `-32700` | `JSONRPC_PARSE_ERROR` |
| `-32600` | `JSONRPC_INVALID_REQUEST` (batches) |
| `-32601` | `JSONRPC_METHOD_NOT_FOUND` |
| `-32602` | `JSONRPC_INVALID_PARAMS` (unrecognized `tools/call` `params.name`) |
| `-32603` | `JSONRPC_INTERNAL_ERROR` |
| `-32020` | 2026-07-28 header mismatch (`Mcp-Method`, `Mcp-Name` or the protocol version) |
| `-32022` | 2026-07-28 unsupported protocol version |
| `-32001` | `JSONRPC_UNAUTHORIZED` |

## `createMcpHandler` options

| Option | Required | Description |
|--------|----------|-------------|
| `registry` | yes | From `createToolRegistry` |
| `ports` | yes | `authenticate`, `context`, optional `audit` — see [Ports](guide.md#ports--what-you-implement) |
| `serverInfo` | yes | `{ name, version }` |
| `wwwAuthenticate` | yes | Static or `(req) => …` for RFC 9728 PRM URL |
| `instructions` | no | Returned on `initialize` |
| `publicMethods` | no | Default: `initialize`, `ping`, notifications. A request that carries the 2026-07-28 header is anonymous only for `server/discover` by default, or for what you list here (never `initialize` or `ping`) |
| `auditTimeoutMs` | no | Max time to wait for `ports.audit` before responding anyway. Default 1000ms — see [security.md](security.md) |
| `allowedRequestOrigins` | no | Browser `Origin` allowlist. Omitted → reject any present `Origin`; no header → allow; `"*"` opts out. Distinct from Node Host `allowedOrigins` |

`ports.audit` fires on tool results and on auth denials (bad token, missing
scope, query-string token, rejected browser Origin as `origin_not_allowed`),
plus the 500 path when a host port throws.
Malformed JSON, bad `jsonrpc`, unsupported `MCP-Protocol-Version`, oversized
bodies, and batch requests return JSON-RPC client errors without an audit
entry — those are protocol errors, not auth denials.

## `createOAuthRouter` options

| Option | Default | Description |
|--------|---------|-------------|
| `ports` | — | Required OAuth ports — see [Ports](guide.md#ports--what-you-implement) |
| `resourcePath` | `"/mcp"` | MCP resource path in PRM. Normalized once at construction (a trailing slash is stripped); construction throws if it starts with `/.well-known` or equals `oauthPath` |
| `oauthPath` | `"/mcp/oauth"` | Prefix for authorize / token / register / revoke |
| `realm` | — | Optional realm string |
| `scopes` | `["mcp"]` | Advertised in metadata, and the ceiling `authorize` validates against |
| `defaultScopes` | full `scopes` | Scopes granted when a client omits `scope` entirely. **Required at construction** once `scopes` has more than one entry — the router throws rather than silently granting everything advertised. Must be a subset of `scopes` |
| `tokenEndpointAuthMethods` | `["none"]` | Advertised client auth methods |
| `allowUnregisteredClients` | `true` | `false` requires `clientStore`, unmounts DCR, and rejects unknown `client_id`s (`unauthorized_client` / `invalid_client`) |
| `requireRegisteredClients` | `true` | Reject any `client_id` that isn't `clientStore`-resolved or self-sealed via this server's own `/register` (see [security.md](security.md)). DCR stays mounted, unlike `allowUnregisteredClients: false` — a client just can't invent an id out of thin air. Enforced at `/authorize`, and at `/token`'s `refresh_token` grant and `/revoke` (the `authorization_code` grant's `client_id` is already bound into the sealed code at `/authorize` time, so it's covered indirectly there) |
| `redirect` | see below | Redirect URI allowlist |
| `consent` | see below | Consent/approval policy for `/authorize` |
| `auditTimeoutMs` | `1000` | Max time to wait for `ports.audit` before responding anyway — same as MCP |

**`redirect` (`RedirectAllowlistOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `extra` | `[]` | Exact-match redirect URIs |
| `allowLoopback` | `true` | Allow `http:` loopback — `127.0.0.1`, `[::1]` (any port). `localhost` and `https:` loopback are not accepted — see [security.md](security.md) |
| `allowClaude` | `true` | Allow the Claude.ai Custom Connector callback |
| `allowChatgptConnector` | `false` | Allow ChatGPT's per-connector callback `https://chatgpt.com/connector/oauth/{id}` (one `[A-Za-z0-9_-]{1,128}` id, exact string match). `createMcpApp` turns it on for `clients: ["codex"]` |

Pre-registered clients, and DCR-issued clients whose id was sealed by this
server's own `/register`, bypass this allowlist entirely — they are
validated against their own bound `redirectUris`.

**`consent` (`ConsentOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `render` | built-in interstitial | Render the approval page yourself — return any `Response`, including a redirect to your own route. Receives a `ConsentRequest` with the validated `clientId`, `redirectUri`, `scope`, `resource`, `user`, an opaque `ticket` to embed in your form's `consent_ticket` field, and optionally `clientHost` (a host the server controls) and `clientName` (a CIMD client's cleaned, unverified name) |
| `appName` | `"your account"` | Built-in screen only: what the app is asking to reach |
| `scopeDescriptions` | none | Built-in screen only: a plain-language line per scope, `Record<string, string>` |
| `preApprovedClientIds` | `[]` | Client ids that skip the interstitial and go straight to code issuance. Only honored when `clientStore` actually resolves the id — a DCR or self-invented id is never trusted to skip it |

## `createMcpApp` options

| Option | Default | Description |
|--------|---------|-------------|
| `serverInfo`, `tools`, `auth` | — | Required |
| `clients` | `["claude"]` | Connector compatibility presets to serve (callbacks and auth methods). Not an allowlist: see [Locking down who can register](guide.md#locking-down-who-can-register) |
| `resourcePath` | `"/mcp"` | MCP endpoint path |
| `oauthPath` | `` `${resourcePath}/oauth` `` | OAuth prefix |
| `scopes` | `["mcp"]` | Scopes this server grants |
| `defaultScopes` | full `scopes` | Same as `OAuthRouterOptions.defaultScopes` — required once `scopes` has more than one entry |
| `realm` | `serverInfo.name` | `WWW-Authenticate` realm |
| `extraRedirectUris` | `[]` | Callbacks beyond the client profiles |
| `allowLoopback` | `true` | Allow loopback redirects — see the narrowed `http:`-only, no-`localhost` behavior in [security.md](security.md) |
| `consent` | built-in interstitial | Same as `OAuthRouterOptions.consent` — override the approval page or pre-approve specific client ids |
| `requireRegisteredClients` | `true` | Same as `OAuthRouterOptions.requireRegisteredClients` — inventing a public `client_id` is rejected unless it comes from `clientStore` or this server's own `/register` |
| `instructions`, `validateArgs`, `onToolError`, `context`, `audit`, `auditTimeoutMs`, `allowedRequestOrigins` | — | Passed through to the MCP handler. Top-level `audit` is a unified MCP+OAuth sink (`source`); `auth.audit` overrides OAuth only. `auditTimeoutMs` applies to both |
| `hideToolsOutsideScope` | `false` | Filter `tools/list` to tools the calling principal's scopes actually satisfy (an unscoped tool, or one with `scope: null`, is always listed). `tools/call` already enforces scope on its own (403 `insufficient_scope`) regardless of this setting — turning it on only changes what's discoverable via `tools/list`. `"strict"` hides the same way and also answers a `tools/call` for such a tool as an unknown tool (`-32602`), so a caller cannot tell a hidden tool from a missing one; the denial is still audited as `missing_scope`. |
| `cimdFetch` | `globalThis.fetch` | The fetch CIMD documents are retrieved with. Web `fetch` cannot pin the connection to the address that was checked; a host on Node that must close DNS rebinding passes a fetch that dials only a checked address. It must honour `redirect: "manual"` and `signal`; a response that followed a redirect is refused |
| `cimdAllowedPorts` | any port | Ports a CIMD URL may use, for the first request and every redirect. `[443]` is recommended in production |
| `cimdRequireJsonContentType` | `false` | Refuse a CIMD response that is not served as a JSON media type (`application/json` or `application/*+json`) |
| `resources` | — | General read-only resources (`ResourceDef[]`: fixed `uri`, `name`, optional `scope` and `allow`, `read(ctx)`). Adds `resources/list` and `resources/read` for the principals allowed to see them; nothing changes when it is omitted. See [resources.md](resources.md) |

**A tool's `scope` (`ToolDef.scope`):** required scope, `null` for "any authenticated
principal, deliberately" or omitted for the same at runtime. On a server
advertising more than one `scopes` entry, `createMcpApp` **refuses to
construct** if any tool omits `scope` — an omission there means "any
authenticated principal, including one holding none of the advertised
scopes," which is rarely the intent once there's more than one scope to
have gotten wrong. Pass `scope: null` to state the omission on purpose.
A single-scope server has no such ambiguity and is unaffected.

## Exports

<details>
<summary><code>mcp-trellis</code></summary>

- `createMcpApp`, `createMcpHandler`, `createToolRegistry`
- `consoleAudit` — convenience unified `audit` sink that logs to the console (pass any function for metrics / DB / APM)
- `UnifiedAuditEntry` — `{ source: "mcp" } & AuditEntry` \| `{ source: "oauth" } & OAuthAuditEntry`
- `defineTool`, `apiTool` — typed, validated tool authoring on top of `ToolDef`. `apiTool`'s `timeoutMs` (default 30000, or `false` to disable) and `maxResponseBytes` (default 1 MiB) bound the upstream call; either surfaces as `isError: true`, not a thrown exception. `redirect` (`"manual"` by default, `"error"`, or `"follow"`) controls upstream redirects — see the guide before enabling `"follow"`. An abort on the `Request` your `request` callback returns surfaces as `Request was cancelled`
- `CLIENT_PROFILES`, `DEFAULT_CLIENTS`, `authMethodsFor`, `redirectUrisFor`, `preRegisteredClients`, `hasDynamicClient`
- `parseBearer`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `AccessDeniedError` — throw from `mintAccessToken` or `refreshAccessToken` to refuse a grant on purpose: the token endpoint answers `400 invalid_grant` ("access denied"), and `message` goes to `audit` only. Any other thrown error stays `500 server_error`. From `refreshAccessToken`, throw only after the refresh token is verified and bound to the client and resource, and before you rotate it; before that, return `null`. Also exported from `mcp-trellis/oauth`
- `signedTokenAuth` — one-secret convenience `McpAppAuth` (HMAC access tokens via HKDF). `secret` may be a list for rotation (first signs, all verify). Opt-in: `isUserActive(userId)` runs on every verified token and every refresh; `refreshTtlSeconds` adds single-use rotating refresh tokens and `/revoke` for them (needs `codeStore` and `isUserActive`). Access tokens are not revocable before `ttlSeconds`. Type `SignedTokenAuthOptions`
- `rpcResult`, `rpcError`, JSON-RPC error constants
- `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`
- `jsonResponse({ data, status?, headers?, cors? })` — type `JsonResponseInput` exported
- Types: `McpApp`, `McpAppOptions`, `McpAppAuth`, `VerifiedToken`, `ClientName`, `ClientProfile`, `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolResult`, `ToolRegistry`, `JsonSchema`, `StandardSchemaV1`, `DefineToolOptions`, `ApiToolOptions`, `ApiRequest`, `ClientStore`, `RegisteredClient`, `CodeStore`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `MintedToken`, `OAuthUser`, …

</details>

<details>
<summary><code>mcp-trellis/oauth</code></summary>

- `createOAuthRouter`
- `authorizationServerMetadata`, `protectedResourceMetadata`, `mcpWwwAuthenticate`
- `canonicalResource`, `resourcesEqual`, `DEFAULT_RESOURCE_PATH`
- `isAllowedRedirectUri`, `CLAUDE_CALLBACK`
- `isCimdClientId`, `resolveCimdClient`
- `hashClientSecret`, `verifyClientSecret` — for `ClientStore.secretHash` (hash once at registration time; the library verifies)
- `GRANT_TYPES`, `OAUTH_ERRORS`, `DEFAULT_SCOPE`, `TOKEN_ENDPOINT_AUTH_METHODS`
- Types: `OAuthUser`, `MintedToken`, `OAuthPorts`, `OAuthAuditEntry`, `OAuthRouterOptions`, `OAuthErrorInfo`, `AuthCodeRecord`, `CodeStore`, `ClientStore`, `RegisteredClient`, `ClientAssertion`, `ClientAuth`, `TokenEndpointAuthMethod`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `ConsentOptions`, `ConsentRequest`

</details>

<details>
<summary><code>mcp-trellis/advanced</code></summary>

Building blocks for hosts assembling their own transport or OAuth flow. Less stable than the entries above.

- `timingSafeEqual`, `matchesAny`
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`, `SUPPORTED_SCHEMA_KEYWORDS`, `IGNORED_SCHEMA_KEYWORDS`, `unsupportedKeywords`, `missingObjectType`
- `pickProtocolVersion`, `ASSUMED_HEADER_PROTOCOL_VERSION`
- `emptyResponse`, `optionsResponse`, `corsHeaders`, `methodNotAllowed`
- `issueAuthCode`, `consumeAuthCode` (pass `codeStore`; omitting it is deprecated), `newClientId`
- `verifyPkceS256`, `sha256Base64Url`, `randomBase64Url`
- `readClientAuth`, `firstClientAuthError`
- `firstResourceError`, `resourceErrorInfo`, `normalizeConfiguredPath`
- `parseScope`, `formatScope`, `requestedScopes`, `firstScopeError`, `scopeErrorInfo`
- `advertisedScopes`, `defaultScopes`, `registeredClientsRequired`, `unregisteredClientsAllowed` — resolve the effective option value
- `buildErrorRedirectUrl` — the RFC 6749 §4.1.2.1 error-redirect builder `/authorize` uses
- Types: `AuthCodeRecord`, `CodeStore`, `ClientAuth`

**Deprecated in 2.1:** every symbol above is still importable from `mcp-trellis` or `mcp-trellis/oauth`, where it used to live, as a `@deprecated` alias. Those aliases are removed in the next major release.

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `isAllowedOrigin`, `toWebRequest`, `sendWebResponse`, `readNodeBody`
- `asNodeHandler` options: `origin`, `trustProxy`, `allowedOrigins`, and `allowedHosts` — the exact `Host` values to answer to (**400** otherwise). On by default for a loopback `origin` (`127.0.0.1` / `localhost` / `[::1]` on its port), to stop DNS rebinding; set it yourself for any other fixed origin or to add a LAN address
- Types: `NodeRequestLike`, `NodeResponseLike`, `ToWebRequestOptions`, `ResolveOriginOptions`, `AsNodeHandlerOptions`, `OriginAllowlistOptions`
- `InvalidOriginError` — thrown by `resolveOrigin` for a Host/`X-Forwarded-*` header that can't safely become an origin (missing, carrying a path/query/fragment/credentials, malformed, or a non-`http(s)` scheme). `asNodeHandler` answers it with **400**, not the generic 500 it gives an actual unexpected failure

</details>
