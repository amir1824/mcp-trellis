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

### Migrating to the schema evaluator, tool results and extensions

- A tool schema with a `$schema` other than 2020-12, 2019-09 or draft-07, a draft-style keyword (`definitions`, `dependencies`, array-form `items`, `additionalItems`, `$recursiveRef`, `$recursiveAnchor`), a non-local `$ref` or another [unsupported](#json-schema-2020-12) keyword throws at construction while `validateArgs` is on. Fix the schema, pass a `schemaValidator`, or set `validateArgs: false`.
- `pattern` is now evaluated instead of throwing. A string over 4096 code units is rejected, and a pattern outside the supported regex subset throws at construction (see [`pattern`](#json-schema-2020-12)).
- `JsonSchema` subschema fields (`properties`, `items`, `allOf`, ...) are `JsonSchema | boolean`. Code that reads `schema.properties.x.type` needs a narrowing step. `ToolResult.structuredContent` is `unknown`.
- A non-object `structuredContent` was a tool failure; on a 2026-07-28 request it now passes.
- A 2026-07-28 client that did not declare `io.modelcontextprotocol/ui` no longer sees `_meta.ui` on tools or `ui://` documents. Older clients are unchanged.
- `UiResource` is a union of an `html` and a `blob` variant. Code that spreads or assigns a `Partial<UiResource>` needs a narrower type.
- A result is checked against `outputSchema` when a tool sets one (`validateOutput` follows `validateArgs`). Set `validateOutput: false` to skip it.

## JSON Schema 2020-12

`inputSchema` and `outputSchema` are evaluated by the library's own JSON Schema 2020-12 evaluator. It never fetches anything and never throws on a value. A violation is one short message per problem; the value itself is not echoed.

| Group | Keywords evaluated |
|-------|--------------------|
| Any value | `type` (a name or a list), `enum`, `const` |
| Object | `properties`, `patternProperties`, `additionalProperties`, `propertyNames`, `required`, `minProperties`, `maxProperties`, `dependentRequired`, `dependentSchemas` |
| Array | `items`, `prefixItems`, `contains`, `minContains`, `maxContains`, `minItems`, `maxItems`, `uniqueItems` |
| Number | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| String | `minLength`, `maxLength`, `pattern` |
| Combinators | `allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else` |
| References | `$ref`, `$defs`, `$anchor`: local only (`#`, `#/$defs/name`, `#anchor`) |

- **Annotations, never evaluated:** `description`, `title`, `$comment`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `format`, `contentEncoding`, `contentMediaType`, `contentSchema`, a root `$id` and any key starting with `x-`. `format` is not enforced: check it in the handler or with a `schemaValidator`.
- **Numbers:** `type: number` and `integer` reject a non-finite value (`JSON.parse("1e999")` is `Infinity`).
- **`$schema`:** 2020-12, 2019-09 and draft-07 URIs are accepted and all evaluated as 2020-12. Any other value throws.
- **Throws at construction** while `validateArgs` is on (`validateOutput` for `outputSchema`):
  - the keywords `unevaluatedProperties`, `unevaluatedItems`, `$dynamicRef`, `$dynamicAnchor`, `$vocabulary` and any other unknown keyword;
  - draft-style keywords that mean something else in 2020-12: `definitions`, `dependencies`, array-form `items`, `additionalItems`, `$recursiveRef`, `$recursiveAnchor` (the message names the 2020-12 spelling);
  - a keyword value of the wrong shape, a `pattern` outside the supported regex subset, a `$ref` that is not local or does not resolve, a `$id` below the root, a duplicate `$anchor`, and `properties` or `required` without `type: "object"`.
- **Bounds.** Going over one at construction throws. Going over one while validating rejects the call; it never passes.

| Bound | Value | Constant in `src/mcp/schema/limits.ts` |
|-------|-------|--------------------------------------|
| Subschema nesting | 64 levels | `MAX_SCHEMA_DEPTH` |
| Subschemas per schema | 10,000 | `MAX_SCHEMA_NODES` |
| Recursion while validating one value | 256 steps | `MAX_EVALUATION_DEPTH` |
| Active `$ref` hops | 32 | `MAX_REF_DEPTH` |
| Work units per validation | 1,000,000 | `MAX_EVALUATION_STEPS` |
| String length matched by `pattern` | 4096 UTF-16 code units | `MAX_PATTERN_INPUT_LENGTH` |
| Items compared by `uniqueItems` | 10,000 | `MAX_UNIQUE_ITEMS` |
| Errors reported per value | 20 | `MAX_VALIDATION_ERRORS` |

**`pattern`.** `pattern` and `patternProperties` keys run on the library's own matcher, not on `RegExp`: a Thompson NFA simulation, linear in input length times program size, so no pattern can hang a call. It is an unanchored search over code points, like `RegExp(source, "u").test(input)`, and a differential test pins that. Supported (ECMAScript syntax):

- literals and the escapes `\\ \/ \. \* \+ \? \( \) \[ \] \{ \} \| \^ \$ \t \n \r \f \v \0 \xHH \uHHHH \u{H...}` (and `\-` inside a class);
- `\d \D \w \W \s \S` (ASCII `\d` and `\w`), `.` (not a line terminator), classes `[...]` and `[^...]` with ranges and class escapes, `\b` and `\B`, `^` and `$` (no multiline);
- groups `(...)`, `(?:...)`, `(?<name>...)` (captures are ignored), alternation, and the quantifiers `* + ? {n} {n,} {n,m}`, greedy or lazy (laziness cannot change a yes/no match).

Refused at construction, with the construct named and the schema path: backreferences (`\1`, `\k<n>`), lookahead and lookbehind, `\p{...}` and `\P{...}`, inline flags (`(?i:...)`), `\c`, and any invalid or unterminated syntax. Nothing is partly accepted.

| Bound | Value | Constant in `src/mcp/schema/regex/limits.ts` |
|-------|-------|--------------------------------------|
| Pattern source | 512 characters | `MAX_REGEX_SOURCE_LENGTH` |
| Compiled program (counted repeats are expanded: `a{0,9999}` is refused) | 2000 instructions | `MAX_REGEX_PROGRAM_SIZE` |
| Group nesting | 32 levels | `MAX_REGEX_GROUP_DEPTH` |
| Instruction visits per step of the work budget | 64 | `REGEX_VISITS_PER_STEP` |

Every match is charged to the same work budget as the rest of the validation (input length times program size, divided by 64), so many strings or many property names against a pattern end in the usual "validation stopped" rejection. The worst accepted program (about 2000 instructions with every thread live) took 49 ms on a 4096-character string (28 ms on 2048, Node 22, arm64). A pattern outside the subset needs a `schemaValidator`.

**`schemaValidator`.** `(value, schema) => string[]` replaces the built-in evaluator for every `inputSchema` and `outputSchema`, for example by wrapping Ajv. Pass it to `createMcpApp` or `createToolRegistry`. The construction checks for keywords, `pattern` and object type are skipped, so you vet the schemas. It runs only while `validateArgs` or `validateOutput` is on. It must return one message per violation (`[]` when valid), not throw and not echo `value`. If it throws or returns anything but an array of strings (a promise included), the call fails closed with "Invalid arguments" or "Tool returned an invalid result", and the thrown message is not shown.

`validateAgainstSchema(value, schema)` is exported from `mcp-trellis/advanced` and returns the violations; `SchemaValidator` is exported there as a type.

```ts
import { createToolRegistry } from "mcp-trellis";
import type { JsonSchema } from "mcp-trellis";
import { type SchemaValidator, validateAgainstSchema } from "mcp-trellis/advanced";

const schema: JsonSchema = {
  type: "object",
  $defs: { sku: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" } },
  properties: { sku: { $ref: "#/$defs/sku" } },
  required: ["sku"],
};

console.log(validateAgainstSchema({ sku: "abc" }, schema)); // one message per violation; [] when valid

// Replace the evaluator, here with a wrapper that stands in for Ajv.
const schemaValidator: SchemaValidator = (value, s) => validateAgainstSchema(value, s);
export const registry = createToolRegistry([], { schemaValidator });
```

## Tool results and annotations

| `ToolDef` field | Meaning |
|-----------------|---------|
| `outputSchema` | JSON Schema of `structuredContent`, listed in `tools/list`. The root may be any type. |
| `annotations` | `title` (string) and `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (booleans), listed in `tools/list`. An unknown field or a wrong type throws at construction. |

- **Hints only.** A client must treat annotations as untrusted, and the library never reads them to authorize a call. Use `scope` for that.
- **`structuredContent`** may be any JSON value for a 2026-07-28 client. A client on 2024-11-05, 2025-03-26 or 2025-06-18 never receives a `structuredContent` that is not an object, and `tools/list` leaves out an `outputSchema` whose root `type` is not `"object"`. Always put the answer in `content` as text too: it is all such a client gets.
- **Output check.** While `validateOutput` is on, a result without `isError` from a tool with an `outputSchema` must carry a `structuredContent` that conforms to it. Otherwise the client gets the error result "Tool returned an invalid result", with no violation text and no data. An `isError` result is not checked.

| Option (`createMcpApp`, `createToolRegistry`) | Default | Description |
|-----------------------------------------------|---------|-------------|
| `validateOutput` | follows `validateArgs` (`true`) | Check results against `outputSchema`. A bad `outputSchema` throws at construction while it is on |
| `schemaValidator` | built-in evaluator | Replaces the evaluator for arguments and results: [`schemaValidator`](#json-schema-2020-12) |
| `onOutputViolation(tool, violations)` | none | Called when a result is rejected. The violations can hold the result's data: log them on the server only. A hook that throws never fails the call |

```ts
import { createMcpApp, defineTool, signedTokenAuth } from "mcp-trellis";

const stock = defineTool({
  name: "stock_levels",
  description: "Stock per SKU",
  inputSchema: {
    type: "object",
    properties: { warehouse: { type: "string", "x-mcp-header": "Warehouse" } },
    required: ["warehouse"],
  },
  outputSchema: { type: "array", items: { type: "integer", minimum: 0 } },
  annotations: { title: "Stock levels", readOnlyHint: true },
  scope: "mcp",
  handler: async () => ({
    content: [{ type: "text", text: "[3,0,12]" }], // the only part a pre-2026-07-28 client gets
    structuredContent: [3, 0, 12],
  }),
});

export const app = createMcpApp({
  serverInfo: { name: "stock", version: "1.0.0" },
  auth: signedTokenAuth({
    secret: process.env.OAUTH_CODE_SECRET as string,
    resolveUser: async () => ({ id: "alice" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
  }),
  allowInMemoryCodeStore: true,
  tools: [stock],
  onOutputViolation: (tool, violations) => console.error(tool, violations), // server log only
});
```

### `x-mcp-header`

Put `"x-mcp-header": "Name"` on an `inputSchema` property to have a 2026-07-28 client mirror its value in the `Mcp-Param-Name` request header. Checked at construction, whatever `validateArgs` says:

- The property is reached through `properties` alone from the root (not through `items`, `allOf`, `$ref` and the like).
- The value is a non-empty header token. Names compare case-insensitively and are unique within a tool.
- The property's `type` is `integer`, `string` or `boolean` (`null` may be added).
- A tool has at most 16 of them.

On a 2026-07-28 `tools/call`, after the scope check and before the handler runs, each annotated header must match the body, or the call answers `-32020` over HTTP 400 and the audit entry has `error: "param_header_mismatch"`. The message is fixed text that names the header and never a value.

- Missing, different, longer than 8192 characters, or not decodable: "header does not match the request body". Characters outside visible ASCII, space and tab: "header contains invalid characters".
- A property that is `null` or absent in the body expects no header.
- Strings compare exactly and booleans are `true` or `false`. An integer must be within ±(2^53−1) and written canonically: `0`, `-7`, `42`, or `42.0`, which equals `42`. `+7`, `042`, `-0`, `42.000`, `0x2A` and `1e1` do not match.
- A `=?base64?...?=` value keeps a leading byte-order mark, so `=?base64?77u/YQ==?=` is not `a`.
- A value with other characters is sent as `=?base64?...?=`.
- A header for a property without the annotation is ignored. Older protocol versions skip the check.

Limits:

- The Node adapter (`asNodeHandler`) refuses a repeated annotated `Mcp-Param-*` header by reading `rawHeaders`. A host that builds its own `Request` sees repeated headers merged into one value and must reject them first.
- The browser preflight lists every registered `Mcp-Param-*` name, so the names of annotated parameters are visible to anonymous callers. With `hideToolsOutsideScope` on, the anonymous preflight lists only the names of tools that have no `scope`.

## Client extensions

A 2026-07-28 client lists the extensions it supports per request, in `_meta["io.modelcontextprotocol/clientCapabilities"].extensions` (an object of extension id to settings object). An entry that is not an object, or an `extensions` that is not an object, counts as not declared. A request on an older version, including `initialize`, declares nothing and sees everything.

A 2026-07-28 request is shown MCP Apps (`_meta.ui` on tools, `ui://` documents) only when the client declared `io.modelcontextprotocol/ui` with `mimeTypes` that include `text/html;profile=mcp-app`. Otherwise:

- `tools/list` has no `_meta.ui`,
- `resources/list` has no `ui://` documents,
- `resources/read` of a `ui://` URI is answered as an unknown resource (`-32602`).

A server with `uiResources` declares `extensions["io.modelcontextprotocol/ui"]: {}` in `initialize` and `server/discover`, next to the Skills extension when `skills` is set.

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
| `-32020` | 2026-07-28 header mismatch (`Mcp-Method`, `Mcp-Name`, `Mcp-Param-*` or protocol version) |
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
| `validateArgs` | `true` | Validate `tools/call` arguments against each tool's `inputSchema` ([keywords](#json-schema-2020-12)); also checks the schemas at construction |
| `validateOutput`, `onOutputViolation`, `schemaValidator` | follows `validateArgs`, none, built-in | Check results against `outputSchema`, and replace the evaluator: [Tool results](#tool-results-and-annotations) |
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
- Types: `McpApp`, `McpAppOptions`, `McpAppAuth`, `UnifiedAuditEntry`, `VerifiedToken`, `SignedTokenAuthOptions`, `ClientName`, `ClientProfile`, `McpHandler`, `McpHandlerOptions`, `McpPorts`, `Principal`, `AuditEntry`, `ServerInfo`, `ToolDef`, `ToolHandler`, `ToolListEntry`, `ToolRegistry`, `RegistryOptions`, `ToolResult`, `ContentBlock`, `JsonSchema`, `StandardSchemaV1`, `DefineToolOptions`, `ApiToolOptions`, `ApiRequest`, `ToolAnnotations`, `ToolUi`, `UiCsp`, `UiDocument`, `UiPermission`, `UiPermissions`, `UiResource`, `UiVisibility`, `ResourceDef`, `ResourceBody`, `SkillDef`, `SkillFile`, `JsonResponseInput`, `JsonResponseOptions`, `JsonRpcId`, `JsonRpcRequest`, `JsonRpcResponse`, `WwwAuthenticateOptions`, `ClientStore`, `RegisteredClient`, `CodeStore`, `ConsentOptions`, `ConsentRequest`, `MintAccessTokenInput`, `RefreshAccessTokenInput`, `RevokeTokenInput`, `MintedToken`, `OAuthUser`

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
- `validateAgainstSchema`, `JSON_SCHEMA_TYPES`, `SUPPORTED_SCHEMA_KEYWORDS`, `IGNORED_SCHEMA_KEYWORDS`, `unsupportedKeywords`, `missingObjectType`; type `SchemaValidator`
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
