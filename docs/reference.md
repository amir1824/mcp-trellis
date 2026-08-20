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
| `/mcp/oauth/authorize` | Authorization endpoint |
| `/mcp/oauth/token` | Token endpoint |
| `/mcp/oauth/revoke` | Token revocation (RFC 7009; mounted only when `revokeToken` is set) |

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
| **400** | Parse error, batch array, invalid request |
| **401** | Missing/invalid Bearer; includes `WWW-Authenticate` |
| **405** | Wrong HTTP verb on MCP |

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

## `createOAuthRouter` options

| Option | Default | Description |
|--------|---------|-------------|
| `ports` | — | Required OAuth ports — see [Ports](guide.md#ports--what-you-implement) |
| `resourcePath` | `"/mcp"` | MCP resource path in PRM |
| `oauthPath` | `"/mcp/oauth"` | Prefix for authorize / token / register / revoke |
| `realm` | — | Optional realm string |
| `scopes` | `["mcp"]` | Advertised in metadata, and the ceiling `authorize` validates against |
| `tokenEndpointAuthMethods` | `["none"]` | Advertised client auth methods |
| `allowUnregisteredClients` | `true` | `false` requires `clientStore`, unmounts DCR, and rejects unknown `client_id`s (`unauthorized_client` / `invalid_client`) |
| `redirect` | see below | Redirect URI allowlist |

**`redirect` (`RedirectAllowlistOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `extra` | `[]` | Exact-match redirect URIs |
| `allowLoopback` | `true` | Allow `http(s)` loopback — `127.0.0.1`, `[::1]`, `localhost` |
| `allowClaude` | `true` | Allow the Claude.ai Custom Connector callback |

Pre-registered clients bypass this allowlist entirely — they are validated
against their own `redirectUris` from `clientStore`.

## `createMcpApp` options

| Option | Default | Description |
|--------|---------|-------------|
| `serverInfo`, `tools`, `auth` | — | Required |
| `clients` | `["claude"]` | Connector profiles to serve |
| `resourcePath` | `"/mcp"` | MCP endpoint path |
| `oauthPath` | `` `${resourcePath}/oauth` `` | OAuth prefix |
| `scopes` | `["mcp"]` | Scopes this server grants |
| `realm` | `serverInfo.name` | `WWW-Authenticate` realm |
| `extraRedirectUris` | `[]` | Callbacks beyond the client profiles |
| `allowLoopback` | `true` | Allow loopback redirects |
| `instructions`, `validateArgs`, `onToolError`, `context`, `audit` | — | Passed through |

## Exports

<details>
<summary><code>mcp-trellis</code></summary>

- `createMcpApp`, `createMcpHandler`, `createToolRegistry`
- `consoleAudit` — convenience `audit` sink that logs to the console (pass any function for metrics / DB / APM)
- `defineTool`, `apiTool` — typed, validated tool authoring on top of `ToolDef`
- `CLIENT_PROFILES`, `DEFAULT_CLIENTS`, `authMethodsFor`, `redirectUrisFor`, `preRegisteredClients`, `hasDynamicClient`
- `parseBearer`, `timingSafeEqual`, `matchesAny`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`, `SUPPORTED_SCHEMA_KEYWORDS`, `IGNORED_SCHEMA_KEYWORDS`, `unsupportedKeywords`
- `rpcResult`, `rpcError`, JSON-RPC error constants
- `pickProtocolVersion`, `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`
- `jsonResponse`, `emptyResponse`, `optionsResponse`, `corsHeaders`, `methodNotAllowed`
- Types: `McpApp`, `McpAppOptions`, `McpAppAuth`, `VerifiedToken`, `ClientName`, `ClientProfile`, `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolResult`, `ToolRegistry`, `JsonSchema`, `StandardSchemaV1`, `DefineToolOptions`, `ApiToolOptions`, `ApiRequest`, `ClientStore`, `RegisteredClient`, `CodeStore`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `MintedToken`, `OAuthUser`, …

</details>

<details>
<summary><code>mcp-trellis/oauth</code></summary>

- `createOAuthRouter`
- `authorizationServerMetadata`, `protectedResourceMetadata`, `mcpWwwAuthenticate`
- `canonicalResource`, `resourcesEqual`, `firstResourceError`, `DEFAULT_RESOURCE_PATH`
- `isAllowedRedirectUri`, `CLAUDE_CALLBACK`
- `issueAuthCode`, `consumeAuthCode`, `newClientId`
- `verifyPkceS256`, `sha256Base64Url`, `randomBase64Url`
- `readClientAuth`, `firstClientAuthError`, `unregisteredClientsAllowed`
- `parseScope`, `formatScope`, `requestedScopes`, `firstScopeError`
- `GRANT_TYPES`, `OAUTH_ERRORS`, `DEFAULT_SCOPE`, `TOKEN_ENDPOINT_AUTH_METHODS`
- Types: `OAuthUser`, `MintedToken`, `OAuthPorts`, `OAuthRouterOptions`, `AuthCodeRecord`, `CodeStore`, `ClientStore`, `RegisteredClient`, `ClientAuth`, `TokenEndpointAuthMethod`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `isAllowedOrigin`, `toWebRequest`, `sendWebResponse`, `readNodeBody`
- Types: `NodeRequestLike`, `NodeResponseLike`, `ToWebRequestOptions`, `ResolveOriginOptions`, `AsNodeHandlerOptions`, `OriginAllowlistOptions`

</details>
