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
| `notifications/*` | public | HTTP 202 empty body |

Anything else → JSON-RPC `-32601`. Capabilities advertise **tools only**.

## HTTP and JSON-RPC status codes

| HTTP | When |
|------|------|
| **202** | Notification (empty body) |
| **400** | Parse error, batch array, invalid request, `jsonrpc` not `"2.0"`, unsupported `MCP-Protocol-Version` |
| **401** | Missing/invalid Bearer; includes `WWW-Authenticate`; echoes the real request id, not `null` |
| **403** | Authenticated, but the token's scopes don't include the tool's `scope`; `WWW-Authenticate` carries `error="insufficient_scope"` and `scope="<required>"` (RFC 6750 §3.1) |
| **405** | Wrong HTTP verb on MCP |
| **413** | Request body over the cap — `/mcp` (1 MiB default), `/token`/`/revoke`/`/register` (64 KiB default) |

| JSON-RPC code | Constant |
|---------------|----------|
| `-32700` | `JSONRPC_PARSE_ERROR` |
| `-32600` | `JSONRPC_INVALID_REQUEST` (batches) |
| `-32601` | `JSONRPC_METHOD_NOT_FOUND` |
| `-32602` | `JSONRPC_INVALID_PARAMS` (unrecognized `tools/call` `params.name`) |
| `-32603` | `JSONRPC_INTERNAL_ERROR` |
| `-32001` | `JSONRPC_UNAUTHORIZED` |

## `createMcpHandler` options

| Option | Required | Description |
|--------|----------|-------------|
| `registry` | yes | From `createToolRegistry` |
| `ports` | yes | `authenticate`, `context`, optional `audit` — see [Ports](guide.md#ports--what-you-implement) |
| `serverInfo` | yes | `{ name, version }` |
| `wwwAuthenticate` | yes | Static or `(req) => …` for RFC 9728 PRM URL |
| `instructions` | no | Returned on `initialize` |
| `publicMethods` | no | Default: `initialize`, `ping`, notifications |
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

Pre-registered clients, and DCR-issued clients whose id was sealed by this
server's own `/register`, bypass this allowlist entirely — they are
validated against their own bound `redirectUris`.

**`consent` (`ConsentOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `render` | built-in interstitial | Render the approval page yourself — return any `Response`, including a redirect to your own route. Receives a `ConsentRequest` with the validated `clientId`, `redirectUri`, `scope`, `resource`, `user`, and an opaque `ticket` to embed in your form's `consent_ticket` field |
| `preApprovedClientIds` | `[]` | Client ids that skip the interstitial and go straight to code issuance. Only honored when `clientStore` actually resolves the id — a DCR or self-invented id is never trusted to skip it |

## `createMcpApp` options

| Option | Default | Description |
|--------|---------|-------------|
| `serverInfo`, `tools`, `auth` | — | Required |
| `clients` | `["claude"]` | Connector profiles to serve |
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
| `hideToolsOutsideScope` | `false` | Filter `tools/list` to tools the calling principal's scopes actually satisfy (an unscoped tool, or one with `scope: null`, is always listed). `tools/call` already enforces scope on its own (403 `insufficient_scope`) regardless of this setting — turning it on only changes what's discoverable via `tools/list` |

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
- `defineTool`, `apiTool` — typed, validated tool authoring on top of `ToolDef`. `apiTool`'s `timeoutMs` (default 30000, or `false` to disable) and `maxResponseBytes` (default 1 MiB) bound the upstream call; either surfaces as `isError: true`, not a thrown exception
- `CLIENT_PROFILES`, `DEFAULT_CLIENTS`, `authMethodsFor`, `redirectUrisFor`, `preRegisteredClients`, `hasDynamicClient`
- `parseBearer`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `signedTokenAuth` — one-secret convenience `McpAppAuth` (HMAC access tokens via HKDF; no refresh/revoke). Type `SignedTokenAuthOptions`
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

**Deprecated in 2.1:** every symbol above is still importable from `mcp-trellis` or `mcp-trellis/oauth`, where it used to live, as a `@deprecated` alias. Those aliases are removed in 3.0.

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `isAllowedOrigin`, `toWebRequest`, `sendWebResponse`, `readNodeBody`
- Types: `NodeRequestLike`, `NodeResponseLike`, `ToWebRequestOptions`, `ResolveOriginOptions`, `AsNodeHandlerOptions`, `OriginAllowlistOptions`
- `InvalidOriginError` — thrown by `resolveOrigin` for a Host/`X-Forwarded-*` header that can't safely become an origin (missing, carrying a path/query/fragment/credentials, malformed, or a non-`http(s)` scheme). `asNodeHandler` answers it with **400**, not the generic 500 it gives an actual unexpected failure

</details>
