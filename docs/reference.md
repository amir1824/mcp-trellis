# Reference

Package surface, routes, MCP methods, status codes, options, and exports.
Ports and recipes: [guide.md](guide.md). Security: [security.md](security.md).

## Package surface

| Import | What you get |
|--------|----------------|
| `mcp-trellis` | `createMcpApp`, client profiles, MCP handler, tool registry, bearer helpers, HTTP utils |
| `mcp-trellis/oauth` | OAuth 2.1 AS router, PKCE, auth codes, client auth, metadata |
| `mcp-trellis/node` | `asNodeHandler` + `resolveOrigin` for Node `(req, res)` |

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
| `/mcp/oauth/register` | Dynamic client registration (unmounted when DCR is off) |
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
| `tools/call` | Bearer + scope | Runs the tool; missing scope → 401 |
| `notifications/*` | public | HTTP 202 empty body |

Anything else → JSON-RPC `-32601`. Capabilities advertise **tools only**.

## HTTP and JSON-RPC status codes

| HTTP | When |
|------|------|
| **202** | Notification (empty body) |
| **400** | Parse error, batch array, invalid request, `jsonrpc` not `"2.0"`, unsupported `MCP-Protocol-Version` |
| **401** | Missing/invalid Bearer; includes `WWW-Authenticate`; echoes the real request id, not `null` |
| **405** | Wrong HTTP verb on MCP |
| **413** | Request body over the cap — `/mcp` (1 MiB default), `/token`/`/revoke`/`/register` (64 KiB default) |

| JSON-RPC code | Constant |
|---------------|----------|
| `-32700` | `JSONRPC_PARSE_ERROR` |
| `-32600` | `JSONRPC_INVALID_REQUEST` (batches) |
| `-32601` | `JSONRPC_METHOD_NOT_FOUND` |
| `-32602` | `JSONRPC_INVALID_PARAMS` |
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
| `requireRegisteredClients` | `false` | Reject any `client_id` that isn't `clientStore`-resolved or self-sealed via this server's own `/register` (see [security.md](security.md)). DCR stays mounted, unlike `allowUnregisteredClients: false` — a client just can't invent an id out of thin air |
| `redirect` | see below | Redirect URI allowlist |
| `consent` | see below | Consent/approval policy for `/authorize` |

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
| `instructions`, `validateArgs`, `onToolError`, `context`, `audit`, `auditTimeoutMs` | — | Passed through. `audit`/`auditTimeoutMs` are the MCP-side (tool-call) hook — the OAuth side has its own, separate `auth.audit` (see [Ports](guide.md#ports--what-you-implement)) |

`requireRegisteredClients` is not currently exposed at the `createMcpApp`
level — use `createOAuthRouter` directly (see
[compose the primitives](guide.md#advanced-compose-the-primitives)) if you
need it.

## Exports

<details>
<summary><code>mcp-trellis</code></summary>

- `createMcpApp`, `createMcpHandler`, `createToolRegistry`
- `consoleAudit` — convenience `audit` sink that logs to the console (pass any function for metrics / DB / APM)
- `defineTool`, `apiTool` — typed, validated tool authoring on top of `ToolDef`
- `CLIENT_PROFILES`, `DEFAULT_CLIENTS`, `authMethodsFor`, `redirectUrisFor`, `preRegisteredClients`, `hasDynamicClient`
- `parseBearer`, `timingSafeEqual`, `matchesAny`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`, `SUPPORTED_SCHEMA_KEYWORDS`, `IGNORED_SCHEMA_KEYWORDS`, `unsupportedKeywords`, `missingObjectType`
- `rpcResult`, `rpcError`, JSON-RPC error constants
- `pickProtocolVersion`, `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`, `ASSUMED_HEADER_PROTOCOL_VERSION`
- `jsonResponse`, `emptyResponse`, `optionsResponse`, `corsHeaders`, `methodNotAllowed`
- Types: `McpApp`, `McpAppOptions`, `McpAppAuth`, `VerifiedToken`, `ClientName`, `ClientProfile`, `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolResult`, `ToolRegistry`, `JsonSchema`, `StandardSchemaV1`, `DefineToolOptions`, `ApiToolOptions`, `ApiRequest`, `ClientStore`, `RegisteredClient`, `CodeStore`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `MintedToken`, `OAuthUser`, …

</details>

<details>
<summary><code>mcp-trellis/oauth</code></summary>

- `createOAuthRouter`
- `authorizationServerMetadata`, `protectedResourceMetadata`, `mcpWwwAuthenticate`
- `canonicalResource`, `resourcesEqual`, `firstResourceError`, `resourceErrorInfo`, `DEFAULT_RESOURCE_PATH`
- `isAllowedRedirectUri`, `CLAUDE_CALLBACK`
- `issueAuthCode`, `consumeAuthCode`, `newClientId`
- `verifyPkceS256`, `sha256Base64Url`, `randomBase64Url`
- `readClientAuth`, `firstClientAuthError`, `unregisteredClientsAllowed`
- `parseScope`, `formatScope`, `requestedScopes`, `firstScopeError`, `scopeErrorInfo`
- `defaultScopes`, `registeredClientsRequired` — resolve the effective option value, same pattern as `unregisteredClientsAllowed`
- `hashClientSecret`, `verifyClientSecret` — for `ClientStore.secretHash` (hash once at registration time; the library verifies)
- `buildErrorRedirectUrl` — the RFC 6749 §4.1.2.1 helper `/authorize` uses internally, exported for hosts composing their own authorize flow via [compose the primitives](guide.md#advanced-compose-the-primitives)
- `normalizeConfiguredPath` — strips a trailing slash from a configured path (`resourcePath`, `oauthPath`); `createOAuthRouter` applies this to `resourcePath` internally, exported for hosts composing their own routing
- `GRANT_TYPES`, `OAUTH_ERRORS`, `DEFAULT_SCOPE`, `TOKEN_ENDPOINT_AUTH_METHODS`
- Types: `OAuthUser`, `MintedToken`, `OAuthPorts`, `OAuthAuditEntry`, `OAuthRouterOptions`, `OAuthErrorInfo`, `AuthCodeRecord`, `CodeStore`, `ClientStore`, `RegisteredClient`, `ClientAssertion`, `ClientAuth`, `TokenEndpointAuthMethod`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `ConsentOptions`, `ConsentRequest`

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `isAllowedOrigin`, `toWebRequest`, `sendWebResponse`, `readNodeBody`
- Types: `NodeRequestLike`, `NodeResponseLike`, `ToWebRequestOptions`, `ResolveOriginOptions`, `AsNodeHandlerOptions`, `OriginAllowlistOptions`

</details>
