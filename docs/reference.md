# Reference

Package surface, routes, MCP methods, status codes, options and exports.
Ports and recipes: [guide.md](guide.md). Security: [security.md](security.md).

## Package surface

| Import | What you get |
|--------|--------------|
| `mcp-trellis` | `createMcpApp`, client profiles, MCP handler, tool registry, `signedTokenAuth`, bearer helpers, JSON-RPC helpers |
| `mcp-trellis/oauth` | OAuth 2.1 authorization server router, discovery metadata, resource and redirect policy, client-secret hashing |
| `mcp-trellis/node` | `asNodeHandler` and `resolveOrigin` for Node `(req, res)` |
| `mcp-trellis/advanced` | Low-level primitives: PKCE, auth codes, client auth, scope and resource parsing, schema validation, HTTP helpers. Less stable: may change in a minor release |

`createMcpApp` is the batteries-included layer. `createMcpHandler` and `createOAuthRouter` are exported for hosts that own the routing or mount the two halves separately: [compose the primitives](guide.md#advanced-compose-the-primitives).

## Default routes

With `resourcePath: "/mcp"` and `oauthPath: "/mcp/oauth"`:

| Path | Purpose |
|------|---------|
| `/.well-known/oauth-protected-resource` (also with `/mcp` appended) | Protected resource metadata |
| `/.well-known/oauth-authorization-server` (also with `/mcp` appended) | Authorization server metadata |
| `/mcp` | MCP endpoint (POST) |
| `/mcp/oauth/register` | Dynamic client registration. Not mounted when DCR is off. `redirect_uris` must be an array of at most 10 entries, else `400 invalid_client_metadata`. If omitted, it defaults to the Claude callback when the redirect policy allows it, else `400 invalid_redirect_uri`. Answers `201` with the accepted subset |
| `/mcp/oauth/authorize` | GET only. Renders a consent page; it never issues a code directly. After `redirect_uri` is validated, errors redirect to it with `?error=...`. An invalid `redirect_uri` and an oversized `state` answer 400 directly |
| `/mcp/oauth/consent` | POST only. Approves or denies a consent ticket from `/authorize`, then redirects to `redirect_uri` |
| `/mcp/oauth/token` | Token endpoint. JSON or form body |
| `/mcp/oauth/revoke` | RFC 7009 revocation. Mounted only when `revokeToken` is set. JSON or form body |

`createMcpApp` mounts OAuth at `/oauth` when `resourcePath` is `"/"`.

## MCP methods

| Method | Auth | Notes |
|--------|------|-------|
| `initialize` | public | Negotiates the protocol version. Returns `capabilities` |
| `ping` | public | Empty result |
| `tools/list` | Bearer | Lists registry entries |
| `tools/call` | Bearer + scope | No Bearer: 401. Missing scope: 403. A `params.name` that names no tool: `-32602` ([guide](guide.md)) |
| `resources/list`, `resources/read` | Bearer | Only when a UI, `resources` or `skills` is configured, else `-32601`. See [mcp-apps.md](mcp-apps.md) and [resources.md](resources.md) |
| `skills/list`, `skills/get` | Bearer | **Experimental.** Only when `skills` is configured, else `-32601`. See [skills.md](skills.md) |
| `notifications/*` | public | HTTP 202, empty body |

Any other method answers `-32601`. `resources/templates/list`, `resources/subscribe` and `completion/complete` are never served. Capabilities always include `tools`, add `resources` when a UI, `resources` or `skills` is configured, and add the `io.modelcontextprotocol/skills` extension when `skills` is configured.

## 2026-07-28 requests

A POST with `MCP-Protocol-Version: 2026-07-28` is a 2026-07-28 request. It must also carry:

- `_meta` with `io.modelcontextprotocol/protocolVersion` (equal to the header) and `io.modelcontextprotocol/clientCapabilities` (an object). Missing: `-32602` over HTTP 400. A different version: `-32020`.
- `Mcp-Method` equal to the body's `method`. For `tools/call`, `resources/read` and `skills/get`, also `Mcp-Name` equal to the tool name or the URI (non-ASCII values use `=?base64?...?=`). A mismatch is `-32020` over HTTP 400 before any method runs.

| Method | Auth | Result |
|--------|------|--------|
| `server/discover` | public by default | `supportedVersions`, `capabilities`, `_meta["io.modelcontextprotocol/serverInfo"]`, optional `instructions`. `cacheScope` is `"public"` when served without authentication, else `"private"` |
| `tools/list`, `tools/call` | Bearer (+ scope for calls) | As before, plus `resultType` |
| `resources/list`, `resources/read` | Bearer | Only when a UI, `resources` or `skills` is configured |
| `skills/list`, `skills/get` | Bearer | Only when `skills` is configured |

`initialize`, `ping` and any other method answer `404` with `-32601`, after authentication. Every success carries `resultType: "complete"`. `tools/list`, `resources/*` and `skills/*` also carry `ttlMs: 0` and `cacheScope: "private"`. Responses still send `Cache-Control: no-store`. An oversized body answers `-32600` over HTTP 413, also through `asNodeHandler`.

A request whose header and `_meta` protocol version both name the same version this server lacks gets `-32022` with the supported list (never for `initialize`). A request with an unknown header and no matching `_meta` gets the older `-32600` over 400. A tool named like `=?base64?...?=` cannot be called under this header, because that form is always decoded.

### Migrating to 2026-07-28

Nothing is required. Clients on the three older protocol versions behave as before. A host that set its own `publicMethods` and wants `server/discover` anonymous must add it. Browser preflight now also allows the `Mcp-Method` and `Mcp-Name` headers.

### Migrating to the CIMD hardening options

Nothing is required. `cimdFetch`, `cimdAllowedPorts`, `cimdRequireJsonContentType` and `hideToolsOutsideScope: "strict"` are optional and off by default. To opt in, follow the [restrictive profile](security.md#restrictive-profile). To go back, remove the option.

### Migrating to resources

Nothing is required. Registering `resources` adds `resources/list`, `resources/read` and the `resources` capability. The audit `error` field can then be `resource_failed`, `rule_denied` or `rule_failed`; a host that switches exhaustively on it should handle them. To go back, remove the option. See [resources.md](resources.md).

### Migrating to skills

Experimental and opt-in; nothing is required. Registering `skills` adds `skills/list`, `skills/get`, the files at `skill://<name>/...` and the skills extension. To go back, remove the option. See [skills.md](skills.md).

## Status codes

| HTTP | When |
|------|------|
| 202 | Notification (empty body) |
| 400 | Parse error, batch array, invalid request, `jsonrpc` not `"2.0"`, unsupported `MCP-Protocol-Version`, 2026-07-28 header or `_meta` problems |
| 401 | Missing or invalid Bearer, or a query-string token. Includes `WWW-Authenticate`. Echoes the request id |
| 403 | Authenticated but the token lacks the tool's `scope` (`WWW-Authenticate` carries `error="insufficient_scope"` and `scope="<required>"`), or a browser `Origin` that is not allowed |
| 404 | A 2026-07-28 request for a method this server does not implement |
| 405 | Wrong HTTP verb on `/mcp`. `GET` with an `Authorization` header answers 405 without checking it |
| 413 | Body over the cap: `/mcp` 1 MiB, `/token`, `/revoke`, `/register` 64 KiB |
| 500 | A host port threw (`-32603` for MCP, `server_error` for OAuth) |

| JSON-RPC code | Meaning |
|---------------|---------|
| `-32700` | `JSONRPC_PARSE_ERROR` |
| `-32600` | `JSONRPC_INVALID_REQUEST`: batch, bad envelope, unsupported protocol version header |
| `-32601` | `JSONRPC_METHOD_NOT_FOUND` |
| `-32602` | `JSONRPC_INVALID_PARAMS`: unknown tool, resource or skill, bad params |
| `-32603` | `JSONRPC_INTERNAL_ERROR` |
| `-32001` | `JSONRPC_UNAUTHORIZED` (401) |
| `-32002` | Payload too large (413), except under 2026-07-28 |
| `-32003` | Insufficient scope (403) |
| `-32020` | 2026-07-28 header mismatch (`Mcp-Method`, `Mcp-Name` or protocol version) |
| `-32022` | 2026-07-28 unsupported protocol version |

## `createMcpHandler` options

| Option | Required | Description |
|--------|----------|-------------|
| `registry` | yes | From `createToolRegistry` |
| `ports` | yes | `authenticate`, `context`, optional `audit`: [Ports](guide.md#ports--what-you-implement) |
| `serverInfo` | yes | `{ name, version }` |
| `wwwAuthenticate` | yes | Static, or `(req) => ...`, for the RFC 9728 resource metadata URL |
| `instructions` | no | Returned on `initialize` and `server/discover` |
| `publicMethods` | no | Default: `initialize`, `ping`, notifications. Under the 2026-07-28 header the default is `server/discover` only, plus what you list (never `initialize` or `ping`) |
| `auditTimeoutMs` | no | Longest wait for `ports.audit` before responding anyway. Default 1000 |
| `allowedRequestOrigins` | no | Browser `Origin` allowlist. Omitted: any present `Origin` is rejected with 403. No header: allowed. `"*"` opts out. Not the same as `allowedOrigins` on `asNodeHandler` |
| `hideToolsOutsideScope` | no | See the `createMcpApp` table |
| `uiResources` | no | [MCP Apps](mcp-apps.md) documents |
| `resources` | no | [General resources](resources.md) |
| `skills` | no | [Skills](skills.md), experimental |

`ports.audit` fires on tool results, on resource and skill calls, and on auth denials (bad token, missing scope, query-string token, a rejected `Origin` as `origin_not_allowed`), plus the 500 path when a host port throws. Protocol errors (malformed JSON, bad `jsonrpc`, unsupported version, oversized body, batch) are not audited.

## `createOAuthRouter` options

| Option | Default | Description |
|--------|---------|-------------|
| `ports` | required | OAuth ports: [Ports](guide.md#ports--what-you-implement). `ports.codeStore` is required unless `allowInMemoryCodeStore` is `true` |
| `allowInMemoryCodeStore` | `false` | Allow a process-local single-use store. For single-process demos and tests |
| `resourcePath` | `"/mcp"` | MCP path in the resource metadata. A trailing slash is stripped. Throws if it starts with `/.well-known` or equals `oauthPath` |
| `oauthPath` | `"/mcp/oauth"` | Prefix for authorize, token, register and revoke |
| `realm` | none | Realm string |
| `scopes` | `["mcp"]` | Advertised in metadata; the ceiling `/authorize` validates against |
| `defaultScopes` | full `scopes` | Scopes granted when a client sends no `scope`. Required once `scopes` has more than one entry. Must be a subset of `scopes` |
| `tokenEndpointAuthMethods` | `["none"]` | Advertised client auth methods |
| `allowUnregisteredClients` | `true` | `false` requires `clientStore`, unmounts DCR and rejects unknown `client_id`s (`unauthorized_client` at authorize, `invalid_client` at token and revoke) |
| `requireRegisteredClients` | `true` | Reject any `client_id` that `clientStore` does not resolve or that this server did not issue through `/register`. DCR stays mounted. Enforced at `/authorize`, the `refresh_token` grant and `/revoke` |
| `cimd` | `false` | Resolve Client ID Metadata Documents (HTTPS URL `client_id`s). See [security.md](security.md) |
| `cimdCache`, `cimdLookup` | none | CIMD document cache (strongly recommended with `cimd: true`) and DNS lookup |
| `cimdFetch` | `globalThis.fetch` | Fetch used for CIMD documents. A host on Node can pass one that dials only a checked address. It must honour `redirect: "manual"` and `signal`; a response that followed a redirect is refused |
| `cimdAllowedPorts` | any port | Ports a CIMD URL may use, for the first request and every redirect. `[443]` is recommended |
| `cimdRequireJsonContentType` | `false` | Refuse a CIMD response not served as `application/json` or `application/*+json` |
| `redirect` | see below | Redirect URI allowlist |
| `consent` | see below | Consent policy |
| `auditTimeoutMs` | `1000` | Longest wait for `ports.audit` |

**`redirect` (`RedirectAllowlistOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `extra` | `[]` | Exact-match redirect URIs |
| `allowLoopback` | `true` | Allow `http:` loopback: `127.0.0.1` and `[::1]` on any port. `localhost` and `https:` loopback are refused |
| `allowClaude` | `true` | Allow the Claude connector callback |
| `allowChatgptConnector` | `false` | Allow `https://chatgpt.com/connector/oauth/{id}` (one `[A-Za-z0-9_-]{1,128}` id). `createMcpApp` turns it on for `clients: ["codex"]` |

Pre-registered clients, and clients whose id this server sealed in `/register`, skip this allowlist. They are checked against their own `redirectUris`.

**`consent` (`ConsentOptions`):**

| Field | Default | Description |
|-------|---------|-------------|
| `render` | built-in page | Render the approval page yourself and return a `Response`. Receives a `ConsentRequest`: `clientId`, `redirectUri`, `scope`, `resource`, `user`, an opaque `ticket` for your form's `consent_ticket` field, and optionally `clientHost` and `clientName` (a CIMD client's cleaned, unverified name) |
| `appName` | `"your account"` | Built-in page: what the app asks to reach |
| `scopeDescriptions` | none | Built-in page: one plain-language line per scope (`Record<string, string>`) |
| `preApprovedClientIds` | `[]` | Client ids that skip the page. Honored only when `clientStore` resolves the id |

## `createMcpApp` options

| Option | Default | Description |
|--------|---------|-------------|
| `serverInfo`, `tools`, `auth` | required | `auth` is `McpAppAuth`: [Ports](guide.md#ports--what-you-implement) |
| `clients` | `["claude"]` | Connector presets to serve (callbacks and auth methods). Not an allowlist: [Locking down who can register](guide.md#locking-down-who-can-register) |
| `resourcePath` | `"/mcp"` | MCP endpoint path |
| `oauthPath` | `` `${resourcePath}/oauth` `` | OAuth prefix |
| `scopes`, `defaultScopes`, `realm` | `["mcp"]`, full `scopes`, `serverInfo.name` | As on the router. `realm` is the `WWW-Authenticate` realm |
| `extraRedirectUris`, `allowLoopback` | `[]`, `true` | Callbacks beyond the client profiles; loopback redirects |
| `consent`, `requireRegisteredClients`, `allowInMemoryCodeStore`, `cimd`, `cimdCache`, `cimdLookup`, `cimdFetch`, `cimdAllowedPorts`, `cimdRequireJsonContentType` | as on the router | Passed to the router |
| `validateArgs` | `true` | Validate `tools/call` arguments against each tool's `inputSchema` |
| `instructions`, `onToolError`, `context`, `allowedRequestOrigins` | none | Passed to the MCP handler. `context` defaults to `{}`. `onToolError` maps a thrown error to client-visible text (default `"Tool execution failed"`) |
| `audit`, `auditTimeoutMs` | none, `1000` | `audit` is one sink for MCP and OAuth events, each tagged `source: "mcp"` or `"oauth"`. `auth.audit` overrides OAuth delivery. `auditTimeoutMs` applies to both |
| `hideToolsOutsideScope` | `false` | `true` lists only tools the caller's scopes satisfy (a tool with no `scope` is always listed). `tools/call` enforces scope either way, with 403. `"strict"` also answers a call to a hidden tool as an unknown tool (`-32602`), so a caller cannot tell it from a missing one. The denial is still audited as `missing_scope` |
| `uiResources` | none | [MCP Apps](mcp-apps.md) documents that tools reference with `ui` |
| `resources` | none | [General resources](resources.md): fixed `uri`, `name`, optional `scope` and `allow`, `read(ctx)` |
| `skills` | none | **Experimental.** [Skills](skills.md): text served at `skill://<name>/...`, never run |

**A tool's `scope`:** the scope the principal needs. `null` or omitted means any authenticated principal. With more than one entry in `scopes`, `createMcpApp` refuses to construct if a tool, resource or skill omits `scope`, because an omission would admit a principal holding none of the scopes. Pass `scope: null` to say so on purpose. A single-scope server is not affected.

## Exports

<details>
<summary><code>mcp-trellis</code></summary>

- `createMcpApp`, `createMcpHandler`, `createToolRegistry`
- `consoleAudit`: a unified `audit` sink that logs to the console. Pass any function for metrics, a database or APM
- `defineTool`, `apiTool`: typed, validated tool authoring on top of `ToolDef`. `apiTool` bounds the upstream call with `timeoutMs` (default 30000, or `false` to disable) and `maxResponseBytes` (default 1 MiB); either surfaces as `isError: true`. `redirect` is `"manual"` (default), `"error"` or `"follow"`: see the guide before using `"follow"`
- `signedTokenAuth`: one-secret `McpAppAuth` (HMAC access tokens). `secret` may be a list for rotation (the first signs, all verify). `isUserActive(userId)` runs on every verified token and refresh. `refreshTtlSeconds` adds single-use rotating refresh tokens and `/revoke` for them (needs `codeStore` and `isUserActive`). Access tokens are not revocable before `ttlSeconds`. See [Sessions and expiry](security.md#sessions-and-expiry)
- `AccessDeniedError`: throw from `mintAccessToken` or `refreshAccessToken` to refuse a grant on purpose. The token endpoint answers `400 invalid_grant` and `message` goes to `audit` only. Any other thrown error is `500 server_error`. From `refreshAccessToken`, throw only after the token is verified and bound to the client and resource, and before you rotate it; before that, return `null`. Also exported from `mcp-trellis/oauth`
- `CLIENT_PROFILES`, `DEFAULT_CLIENTS`, `authMethodsFor`, `redirectUrisFor`, `preRegisteredClients`, `hasDynamicClient`
- `parseBearer`, `wwwAuthenticateHeader`, `rejectQueryToken`
- `rpcResult`, `rpcError`, the `JSONRPC_*` error constants
- `PROTOCOL_VERSIONS`, `DEFAULT_PROTOCOL_VERSION`
- `jsonResponse({ data, status?, headers?, cors? })`
- Types: `McpApp`, `McpAppOptions`, `McpAppAuth`, `UnifiedAuditEntry`, `VerifiedToken`, `SignedTokenAuthOptions`, `ClientName`, `ClientProfile`, `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolListEntry`, `ToolRegistry`, `RegistryOptions`, `ToolResult`, `ContentBlock`, `JsonSchema`, `StandardSchemaV1`, `DefineToolOptions`, `ApiToolOptions`, `ApiRequest`, `ToolUi`, `UiCsp`, `UiResource`, `UiVisibility`, `ResourceDef`, `ResourceBody`, `SkillDef`, `SkillFile`, `JsonResponseInput`, `JsonResponseOptions`, `JsonRpcId`, `JsonRpcRequest`, `JsonRpcResponse`, `WwwAuthenticateOptions`, `ClientStore`, `RegisteredClient`, `CodeStore`, `ConsentOptions`, `ConsentRequest`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `MintedToken`, `OAuthUser`

</details>

<details>
<summary><code>mcp-trellis/oauth</code></summary>

- `createOAuthRouter`
- `authorizationServerMetadata`, `protectedResourceMetadata`, `mcpWwwAuthenticate`
- `canonicalResource`, `resourcesEqual`, `DEFAULT_RESOURCE_PATH`
- `isAllowedRedirectUri`, `CLAUDE_CALLBACK`
- `isCimdClientId`, `resolveCimdClient`
- `hashClientSecret`, `verifyClientSecret`: for `ClientStore.secretHash`. Hash once at registration; the library verifies
- `AccessDeniedError`
- `GRANT_TYPES`, `OAUTH_ERRORS`, `DEFAULT_SCOPE`, `TOKEN_ENDPOINT_AUTH_METHODS`
- Types: `OAuthRouter`, `OAuthUser`, `MintedToken`, `OAuthPorts`, `OAuthAuditEntry`, `OAuthRouterOptions`, `OAuthErrorInfo`, `AuthCodeRecord`, `CodeStore`, `ClientStore`, `RegisteredClient`, `ClientAssertion`, `ClientAuth`, `CimdCache`, `CimdDocument`, `TokenEndpointAuthMethod`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `ConsentOptions`, `ConsentRequest`

</details>

<details>
<summary><code>mcp-trellis/advanced</code></summary>

Building blocks for hosts that assemble their own transport or OAuth flow. Less stable than the entries above.

- `timingSafeEqual`, `matchesAny`
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`, `SUPPORTED_SCHEMA_KEYWORDS`, `IGNORED_SCHEMA_KEYWORDS`, `unsupportedKeywords`, `missingObjectType`
- `pickProtocolVersion`, `ASSUMED_HEADER_PROTOCOL_VERSION`
- `emptyResponse`, `optionsResponse`, `corsHeaders`, `methodNotAllowed`
- `issueAuthCode`, `consumeAuthCode` (pass `codeStore`; omitting it is deprecated), `newClientId`
- `verifyPkceS256`, `sha256Base64Url`, `randomBase64Url`
- `readClientAuth`, `firstClientAuthError`
- `firstResourceError`, `resourceErrorInfo`, `normalizeConfiguredPath`
- `parseScope`, `formatScope`, `requestedScopes`, `firstScopeError`, `scopeErrorInfo`
- `advertisedScopes`, `defaultScopes`, `registeredClientsRequired`, `unregisteredClientsAllowed`: the effective option values
- `buildErrorRedirectUrl`: the RFC 6749 §4.1.2.1 error-redirect builder `/authorize` uses
- Types: `AuthCodeRecord`, `CodeStore`, `ClientAuth`

These symbols are still importable from `mcp-trellis` or `mcp-trellis/oauth`, where they used to live, as `@deprecated` aliases. The aliases are removed in the next major release.

</details>

<details>
<summary><code>mcp-trellis/node</code></summary>

- `asNodeHandler`, `resolveOrigin`, `isAllowedOrigin`, `isAllowedRequestOrigin`, `toWebRequest`, `sendWebResponse`, `readNodeBody`, `bodyLimitForPath`
- `asNodeHandler` options: `origin`, `trustProxy`, `allowedOrigins`, and `allowedHosts`, the exact `Host` values to answer to (400 otherwise). It is on by default for a loopback `origin` (`127.0.0.1`, `localhost`, `[::1]` on its port) to stop DNS rebinding. Set it for any other fixed origin, or to add a LAN address
- `InvalidOriginError`: thrown by `resolveOrigin` for a Host or `X-Forwarded-*` header that cannot safely become an origin (missing, malformed, with a path, query, fragment or credentials, or a non-`http(s)` scheme). `asNodeHandler` answers it with 400
- Types: `NodeRequestLike`, `NodeResponseLike`, `ToWebRequestOptions`, `ResolveOriginOptions`, `AsNodeHandlerOptions`, `OriginAllowlistOptions`

</details>
