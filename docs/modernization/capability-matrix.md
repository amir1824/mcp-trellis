# Capability matrix: mcp-trellis 3.4.0 against MCP 2026-07-28

Status: **Proposed.** Approval belongs to the maintainer (SCRUM-25, approval gate 1).
Written for SCRUM-25 slice T1. Prepared 2026-11-25 from the official specification pages and the source at version 3.4.0 (commit `82526c9` on `chore/factory-engine-2`, whose `src/` equals `main`).

## How to read this

- **Status** is one of: `supported`, `partial`, `missing`, `deprecated`, `experimental`, `not applicable`.
- **Class** is `mandatory` (a server that advertises 2026-07-28 must do it), `optional`, `deprecated` (the spec marks it deprecated) or `out of scope per ticket`. Mandatory is read from the spec text quoted in the row; where the page does not state a level the row says `level not stated`.
- **Spec** is a URL under `https://modelcontextprotocol.io` and the section named on the page. The pages were read through a fetch tool on 2026-11-25; a requirement not found on a primary page is in the [Unverified](#unverified) section and nowhere else.
- **Code** is `file:line` in `src/`. **Test** is an existing test file that exercises the behaviour, or `none`. A test file is named only when it mentions the behaviour; this analysis did not run it for the matrix.
- **Task / release** is where the proposed scope puts the row: T2 to T6 of the ticket and Release A, B or C.
- Nothing here changes code. Rows are claims about the code at the commit above, except M-1 to M-9, which were updated after job scrum-25-t2b (T2) built them.

Spec base for the rows below: `S` = `https://modelcontextprotocol.io/specification/2026-07-28`; `E` = `https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx` (the MCP Apps specification).

## 1. Mandatory protocol changes (for a server that advertises 2026-07-28)

| # | Requirement | Spec | Status | Code | Test | Task / release |
|---|---|---|---|---|---|---|
| M-1 | `server/discover` must be implemented and answer with versions, capabilities, `serverInfo` in `_meta` | `S/server/discover.md`, "Discovery" ("Servers MUST implement it") | supported (T2) | `modern/discover.ts:16-28`, `rpc-handlers.ts:98-103` | `test/mcp/modern/discover.test.ts` | T2 / A |
| M-2 | Every request carries `protocolVersion` and `clientCapabilities` in `_meta`; a request missing them is malformed (`-32602`, HTTP 400) | `S/basic/index.md`, "_meta" and required fields | supported (T2) | `modern/request.ts:74-95` | `test/mcp/modern/request.test.ts` | T2 / A |
| M-3 | The `initialize` handshake is removed; a server must not rely on earlier requests for context | `S/changelog`, Major changes #2; `S/basic/lifecycle.md` ("There is no negotiation handshake") | supported (T2): the new version has no handshake; older versions keep `initialize` | `rpc-handlers.ts:98-111`, `modern/profile.ts:63-72`, `modern/request.ts:29-34` | `test/mcp/modern/request.test.ts` | T2 / A |
| M-4 | `resultType` on every result (`"complete"`, or `"input_required"` for multi round-trip) | `S/basic/index.md`, results ("The result MUST include a resultType field"); `S/changelog`, Major #8 | supported (T2) | `modern/result.ts:8-15` | `test/mcp/modern/tools.test.ts` | T2 / A |
| M-5 | `Mcp-Method` header on every POST; `Mcp-Name` on `tools/call`, `resources/read`, `prompts/get`; mismatch is HTTP 400 with `-32020` | `S/basic/transports/streamable-http.md`; `S/changelog`, Minor #4 | supported (T2) | `modern/request.ts:59-72` | `test/mcp/modern/request.test.ts` | T2 / A |
| M-6 | `MCP-Protocol-Version` header required on every POST | `S/basic/transports/streamable-http.md` ("MUST include") | supported (T2): required under the new header; older versions keep the assumed `2025-03-26` | `dispatch.ts:109-123`, `modern/profile.ts:43-76`, `modern/request.ts:35-37` | `test/mcp/modern/request.test.ts`, `test/mcp/modern/golden.test.ts` | T2 / A (keep the assumption for older versions) |
| M-7 | Unknown version answers `UnsupportedProtocolVersionError` (`-32022`) | `S/basic/lifecycle.md` ("it MUST respond with an UnsupportedProtocolVersionError"); `S/basic/index.md`, error codes | supported (T2) when the header and `_meta` both name the unknown version (not for `initialize`); any other unknown header keeps `-32600` | `modern/request.ts:102-114`, `modern/errors.ts:50-60` | `test/mcp/modern/request.test.ts` | T2 / A |
| M-8 | Servers must not emit `-32002` or `-32042` | `S/basic/index.md`, error code allocation | supported (T2): `-32600` over HTTP 413 under the new header, `-32002` kept for older versions | `dispatch.ts:45-59`, `modern/profile.ts:45-49`, `65`, `modern/errors.ts:66-72, 82-83` | `test/mcp/modern/request.test.ts`, `test/mcp/modern/golden.test.ts` | T2 / A (new code only under the new version; the older versions keep `-32002`) |
| M-9 | Caching hints (`ttlMs`, and `cacheScope`) on `server/discover`, `tools/list`, `resources/list`, `resources/read` (and prompts) results | `S/server/utilities/caching.md`, "Cacheable Results" and "TTL Field" ("MUST provide a ttlMs value that is >= 0") | supported (T2): `ttlMs` 0; `private` for anything served after authentication, `public` only for an anonymous `server/discover` | `modern/cache.ts:17-27`, `modern/result.ts:8-15`, `modern/discover.ts:16-28` | `test/mcp/modern/tools.test.ts`, `test/mcp/modern/discover.test.ts` | T2 / A, with T3 (see section 4) |
| M-10 | Resource not found is `-32602` | `S/server/resources.md` ("MUST return -32602") | supported | `resources/methods.ts` | `test/mcp/ui/protocol.test.ts` | none |
| M-11 | Origin validation: an invalid `Origin` is HTTP 403 | `S/basic/transports/streamable-http.md` (page states a MUST with 403) | supported | `origins.ts:100-110`, `dispatch.ts:155-158` | `test/mcp/dispatch.test.ts`, `test/adapters/origins.test.ts` | none |
| M-12 | `Mcp-Session-Id` is not minted or echoed | `S/basic/transports/streamable-http.md`, "Earlier Streamable HTTP Revisions" (SHOULD ignore) | supported: sessions never existed | no `Mcp-Session-Id` in `src/`, tests or docs | none | none |

M-1 to M-9 together are the work of T2. A server that supports the three older versions and the new one must keep every older behaviour behind the version it was requested with; nothing in this table asks to drop 2024-11-05, 2025-03-26 or 2025-06-18.

## 2. Optional capabilities and deprecated features

| # | Capability | Spec | Class | Status | Code | Test | Task / release |
|---|---|---|---|---|---|---|---|
| O-1 | `ping` | removed in 2026-07-28 (`S/changelog`, Major #5) | deprecated (removed) | supported for older versions | `rpc-handlers.ts:46` | `test/mcp/dispatch.test.ts` (`ping` answered 200 at lines 662-667) | keep for older versions |
| O-2 | `subscriptions/listen`, `notifications/*/list_changed` | `S/basic/patterns/subscriptions.md`; `S/changelog`, Major #4 | optional (server decides whether to notify) | missing; `GET /mcp` answers 405 after auth | `dispatch.ts:86-98`; no `listChanged` in `src/` | none | not proposed; no current use case |
| O-3 | Multi round-trip requests (`input_required`, `requestState`) | `S/basic/patterns/mrtr.md` (servers MUST use it for server-to-client requests) | optional here: Trellis sends no server-to-client request | not applicable | no `elicitation`, `sampling` or `roots` in `src/` | none | not proposed |
| O-4 | Roots, Sampling, Logging | `S/deprecated.md` (deprecated in 2026-07-28; earliest removal on or after 2027-07-28) | deprecated | not applicable | none in `src/` | none | do not adopt |
| O-5 | HTTP+SSE transport | `S/deprecated.md` (deprecated since 2025-03-26) | deprecated | not applicable: JSON responses on POST only | `dispatch.ts:86-98` | none | do not adopt |
| O-6 | OpenTelemetry `_meta` keys (`traceparent`, `tracestate`, `baggage`) | `S/changelog`, Minor #2; `S/basic/index.md` | optional | missing | no `traceparent` in `src/` | none | optional, T2 if cheap |
| O-7 | Pagination (`nextCursor`) on list results | `S/server/utilities/pagination.md` | optional (server sets the page size) | missing | no cursor in `src/` | none | not proposed |
| O-8 | `outputSchema` for tools | `S/server/tools.md` (level for `outputSchema` unverified) | optional | missing; `structuredContent` and `_meta` are passed through | `tools/content.ts:29-49`; no `outputSchema` in `src/` | `test/mcp/ui/protocol.test.ts` | decide in the ADR |
| O-9 | Deterministic tool order | `S/server/tools.md` (SHOULD) | optional | supported: registration order | `registry.ts:157-165` | none | none |
| O-10 | JSON Schema 2020-12 as the default dialect for tool schemas | `S/basic/index.md` (page states MUST support) | mandatory (level as read) | partial: a subset validator; unsupported keywords throw at construction | `registry.ts:111-139`, `validate.ts` | `test/mcp/validate.test.ts` | T2 / A (name the supported subset) |
| O-11 | Request cancellation reaches the handler | `S/basic/patterns/cancellation.md` (closing the response stream is cancellation on Streamable HTTP) | optional here, level for servers not recorded | missing: the handler gets no abort signal (`registry.call(name, ctx, args)`) | `rpc-handlers.ts:82` | none | decide in the ADR |
| O-12 | Prompts (`prompts/list`, `prompts/get`) | `S/server/prompts.md` | optional; **not named in the ticket** | missing | no `prompts` in `src/` | none | needs the maintainer's decision |
| O-13 | Dynamic Client Registration (server side) | `S/deprecated.md` (deprecated in 2026-07-28; migrate to CIMD; earliest removal on or after 2027-07-28) | deprecated | supported, on by default | `metadata.ts:77-79`, `endpoints/register.ts` | `test/oauth/endpoints/dcr.test.ts` | keep; document the timeline |

## 3. Resources and MCP Apps

| # | Capability | Spec | Class | Status | Code | Test | Task / release |
|---|---|---|---|---|---|---|---|
| R-1 | General `resources/list` / `resources/read` for application data | `S/server/resources.md` | optional | supported in T4 (opt-in `resources`: fixed URIs, text bodies, `scope` and `allow`, `read(ctx)`); binary bodies, subscriptions, completion and pagination are not served | `resources/methods.ts`, `resources/read.ts`, `resources/catalog.ts` | `test/mcp/resources/*.test.ts` | done in T4 / B |
| R-2 | `resources/templates/list` | `S/server/resources.md`; caching page lists it | optional | not supported on purpose: answers `-32601`; fixed URIs only (owner decision in T4, templates are an additive option for later) | `resources/methods.ts` (absent) | `test/mcp/resources/protocol.test.ts` | deferred; additive |
| R-3 | `resources` capability declared | `S/server/resources.md` | optional | supported when a UI or general `resources` is configured | `resources/catalog.ts`, `rpc-handlers.ts` | `test/mcp/ui/protocol.test.ts` | none |
| R-4 | Visibility of a resource follows the caller's scopes | ticket section 5 criterion; `S/server/utilities/caching.md`, Security ("MUST apply per-primitive access controls") | mandatory for the caching rules | supported for `ui://` and general resources: scope and `allow`, filtered listing, a refused read answers as an unknown URI under `hideToolsOutsideScope` true or `"strict"` | `resources/access.ts`, `resources/outcome.ts` | `test/mcp/resources/authz.test.ts`, `test/mcp/ui/security.test.ts` | done in T4 / B |
| A-1 | MCP Apps: `ui://` scheme, MIME `text/html;profile=mcp-app` | `E`, "Resource" | stable extension (listed as Stable, 2026-01-26) | supported | `ui/types.ts:3-6` | `test/mcp/ui/protocol.test.ts` | none |
| A-2 | Tool `_meta.ui.resourceUri` and `visibility` (nested form) | `E`, "Resource Discovery" | stable | supported | `ui/registry.ts:24-27` | `test/mcp/ui/protocol.test.ts` | none |
| A-3 | The flat `_meta["ui/resourceUri"]` | `E`, "Resource Discovery" (deprecated) | deprecated | not emitted: correct | `ui/registry.ts:24-27` | none | none |
| A-4 | Resource `_meta.ui.csp`: `connectDomains`, `resourceDomains` | `E`, "CSP" | stable | supported, validated at construction | `ui/csp.ts:46-75`, `resources/methods.ts` | `test/mcp/ui/config.test.ts` | none |
| A-5 | `csp.frameDomains`, `csp.baseUriDomains`, `permissions`, `domain`, `prefersBorder` | `E` (read in full in T4: optional; no level for a server to set them) | optional | not supported, documented in `docs/mcp-apps.md`; omitted CSP keys mean none, so it fails closed; no host that was run failed without them | `ui/types.ts:19-24` lists two CSP keys only | none | left open in T4 (owner decision) |
| A-6 | Capability negotiation: client advertises `extensions["io.modelcontextprotocol/ui"]` with the MIME type; server checks before registering UI tools | `E`, "Capability negotiation" (read in full in T4) | SHOULD (and MAY register variants) | not supported on purpose: the legacy path is stateless, every client sees the same `tools/list`, and a host without the extension ignores `_meta.ui` and shows the text result | none | none | left open in T4 (owner decision) |
| A-7 | Text fallback: a tool result carries meaningful `content` | `E` (read through a summary) | stable | supported | `registry.ts:98-103`, `docs/mcp-apps.md` | `test/mcp/ui/host.test.ts` | none |
| A-8 | Interoperability with real hosts | unverified: no host was run; the ticket criterion is "MCP Apps interoperability results are documented for tested hosts" | n/a | **no host was run in T4** (owner decision: no download); every host is documented as not tested in `docs/mcp-apps.md` | none | `test/mcp/ui/host.test.ts` (a harness, not a real host) | T6 / B |

## 4. Authorization and security (input to T3)

| # | Requirement | Spec | Class | Status | Code | Test | Task / release |
|---|---|---|---|---|---|---|---|
| Z-1 | Protected Resource Metadata (RFC 9728), `authorization_servers`, `WWW-Authenticate resource_metadata` on 401 | `S/basic/authorization/authorization-server-discovery.md` | mandatory (servers MUST implement) | supported | `metadata.ts:59-64`, `:97-105`, `request-policy.ts:78-87`, `auth/bearer.ts:61` | `test/oauth/endpoints/metadata.test.ts`, `test/auth/bearer.test.ts` | none |
| Z-2 | Authorization server metadata (RFC 8414) | `S/basic/authorization`, "Authorization Server Discovery" ("MUST provide RFC 8414 or OIDC Discovery") | mandatory | supported | `metadata.ts:66-95` | `test/oauth/endpoints/metadata.test.ts` | none |
| Z-3 | OAuth 2.1, PKCE with S256 | `S/basic/authorization` ("MUST implement OAuth 2.1"); PKCE rules | mandatory | supported | `metadata.ts:88` | `test/oauth/crypto/pkce.test.ts` | none |
| Z-4 | `resource` parameter (RFC 8707) and token audience validation; servers must reject tokens not issued for them | `S/basic/authorization`, "Access Token Usage"; `S/basic/authorization/security-considerations.md`, "Token Audience" | mandatory | supported | `app.ts:48-63`, `oauth/policy/resource.ts:41-58`, `metadata.ts:91` | `test/auth/signed-token.test.ts`, `test/mcp/app.test.ts` | none |
| Z-5 | Token passthrough is forbidden | `S/basic/authorization/security-considerations.md`; security best practices page | mandatory | supported by default: `apiTool` does not forward the caller's bearer token; a tool author could | `mcp/tools/api-tool.ts` (no `authorization` handling found) | none | document in T3 |
| Z-6 | Tokens never in the query string | `S/basic/authorization`, "Access Token Usage" | mandatory | supported | `dispatch.ts:73-86` | `test/auth/bearer.test.ts` | none |
| Z-7 | `iss` in the authorization response (RFC 9207) and `authorization_response_iss_parameter_supported` | `S/changelog`, Minor #7; `S/basic/authorization` | SHOULD for the server | supported | `endpoints/callback.ts:24-30`, `metadata.ts:92` | `test/oauth/endpoints/callback.test.ts` | none |
| Z-8 | Insufficient scope is 403 with `error="insufficient_scope"` and the scope | `S/basic/authorization`, "Scope Challenge Handling" | mandatory | supported | `request-policy.ts:97-112` | `test/mcp/app.test.ts`, `test/auth/bearer.test.ts` | none |
| Z-9 | Client ID Metadata Documents: https URL with a path, `client_id` equals the URL, validate `redirect_uris`, cache by HTTP headers, consider SSRF | `S/basic/authorization/client-registration.md`; `S/basic/authorization/security-considerations.md`, "Client ID Metadata Document" | SHOULD for servers | supported, off by default | `cimd/cimd.ts`, `metadata.ts:36`, `:93` | `test/oauth/cimd/`, `test/oauth/cimd/hardening.test.ts` | T3 / A (reviewed: `oauth-cimd-review.md`) |
| Z-10 | SSRF defence for CIMD: https only, no credentials, public hostnames and addresses, address check before and after the body, same-origin redirects only, manual redirect handling | `S/basic/authorization/client-registration.md` and `S/basic/authorization/security-considerations.md`; security best practices ("SHOULD block private, loopback and link-local ranges"; "validate per hop") | SHOULD | partial: the DNS check runs again after the body but the connection is not pinned to the checked address; the code names this ceiling itself. T3 adds opt-in `cimdFetch` (a Node host pins the connection), `cimdAllowedPorts` and `cimdRequireJsonContentType`; rebinding stays open for a host that does not pin | `cimd/url-guard.ts:53-69`, `cimd/cimd.ts:5`, `:48`, `:56-70` (the `ponytail` notes on connect pinning), `cimd/cimd-ssrf.ts` | `test/oauth/cimd/failure.test.ts`, `test/oauth/cimd/dns-limits.test.ts` | T3 / A |
| Z-11 | Exact `redirect_uri` validation | `S/basic/authorization/security-considerations.md`, "Open redirection" | mandatory | supported | `oauth/policy/redirect.ts` | `test/oauth/policy/redirect.test.ts` | none |
| Z-12 | Confused deputy: per-client consent before forwarding | `S/basic/authorization/security-considerations.md` (applies to proxy servers with static client ids) | mandatory for proxies | supported: consent interstitial before any code is issued | `oauth/endpoints/consent/handler.ts`, `docs/security.md` row on cross-site authorization | `test/oauth/endpoints/consent.test.ts` | none |
| Z-13 | Servers must not rely on `cacheScope` alone for access control | `S/server/utilities/caching.md`, "Security Considerations" | mandatory | supported (re-verified in T2: M-9 adds hints for 2026-07-28 requests only, and the per-request scope checks still run) | `rpc-handlers.ts:64-72`, `resources/methods.ts` | `test/mcp/ui/security.test.ts`, `test/security/cache-malformed.test.ts` | kept true in T2 and T3 |

### Unauthorized discovery and access, on the current source (R20)

Read from `src/`, not run for this analysis:

- `tools/list` returns every registered tool to any authenticated principal unless `hideToolsOutsideScope` is `true` (default `false`): name, description and input schema are visible to a principal without the tool's scope. `tools/call` still answers 403 `insufficient_scope` (`rpc-handlers.ts:102-126`, `types.ts:81-92`). This default is documented (`docs/reference.md:142`); under a restrictive policy the host must turn the option on. The ADR leaves the default to the maintainer (open point 7).
- **Gap against the ticket's criterion** ("cannot be accessed or discovered under restrictive policies"): `hideToolsOutsideScope` hides `tools/list` entries only. A `tools/call` by name for a tool outside the caller's scope still answers 403 `insufficient_scope` and names the scope, while an unknown name answers `-32602`, so the answers for a hidden tool and an unknown one are not the same (hidden-tool answer parity, T3) (`rpc-handlers.ts:53-87`, `:116-126`; the behaviour is pinned by the `hideToolsOutsideScope` suite in `test/mcp/app.test.ts:547`). `resources/read` behaves differently under the same option: it answers as an unknown URI (`resources/methods.ts`). Proposed for T3: decide whether a hidden tool should answer like an unknown tool. This is reported to the maintainer through the review, not written as steps (see `SECURITY.md` for private reporting).
- `resources/list` and `resources/read` for `ui://` documents filter by the caller's scopes always, and with `hideToolsOutsideScope` a denied read looks like an unknown URI (`resources/methods.ts`).
- A method in `publicMethods` skips authentication (`rpc-handlers.ts:171-186`); the defaults are `initialize`, `ping` and the two initialized notifications (`request-policy.ts:25-30`). `resources/*` answers 401 even when listed there (`resources/methods.ts`).
- No Skill or general Resource exists yet, so there is nothing to discover there; these rows are open for T4 and T5.

### Caches that depend on the caller (R21)

Read from `src/`, not run for this analysis:

- No response cache exists in 3.4.0 (T2 adds hints for 2026-07-28 requests only; see M-9). Every MCP response is `Cache-Control: no-store` (`http.ts:71`), and the UI registry holds user-independent documents (`resources/methods.ts`, `ui/types.ts:31`).
- The in-process maps are keyed by values that do not name a user: derived-key cache by purpose and a secret fingerprint (`oauth/crypto/hkdf.ts:45-49`), the used-code set by token id (`oauth/crypto/codes.ts:39-56`, single process only), and the host-supplied CIMD cache by `client_id` (`cimd/cimd.ts:150-173`), whose content is public client metadata.
- **Adopting M-9 creates the first caller-dependent cache.** With `hideToolsOutsideScope: true`, `tools/list` differs per principal, and `resources/list` always does; both must carry `cacheScope: "private"`. So must `resources/read` of a `ui://` document and the unfiltered `tools/list`: their content is the same for every caller who may read it, but they are served only after authentication and scope checks, and a `public` hint lets a shared cache hand the content to a caller who failed those checks. `public` fits only a result the server serves to anyone without authentication. The spec allows `public` only for results identical for every user (`S/server/utilities/caching.md`, "Cache Scope Field" and "Choosing a Cache Scope"). A `public` hint on a filtered list is the leak this ticket's criterion forbids.

## 5. Proposed implementation scope (R16)

Proposed, for the maintainer to approve or change. Release letters follow the ticket's release strategy.

| Rows | Ticket task | Release | Note |
|---|---|---|---|
| M-1 to M-9, O-10, O-6 | T2 Protocol Modernization | A | One version-aware layer; older versions untouched |
| Z-9, Z-10, Z-13 and the two assessments above, including the `tools/call` answer for a hidden tool | T3 Authorization & Security Hardening | A | M-9 and Z-13 are reviewed together; done in T3 with the opt-in `"strict"` answer for a hidden tool |
| R-1, R-2, R-4, A-5, A-6, A-8 | T4 Resources & MCP Apps | B | Done in T4: R-1 and R-4 supported; R-2, A-5 and A-6 left open by owner decision; A-8 documents that no host was run (T6 may add one) |
| O-12 (prompts) | none: not named in the ticket | none | Maintainer decision |
| O-11, O-8 | undecided | A or later | Decide in the ADR review |
| O-2, O-3, O-7 | none | none | No current use case; not proposed |
| Skills (not in the rows above) | T5 | C | Experimental; see U-5 |
| Reference application | T6 | per release | |

### Out of scope per ticket

The ticket's section 8 excludes MCP Tasks, File Transfer, Events and others. In the spec: Tasks moved to the extension `io.modelcontextprotocol/tasks` (`S/changelog`, Major #6); Events and Server Cards are listed as Beta on `https://modelcontextprotocol.io/extensions`; no extension named File Transfer was found on the listing; the nearest names are experimental (`experimental-ext-file-uploads`, `experimental-ext-filesystems`, `https://modelcontextprotocol.io/extensions`), and whether the ticket means one of them is unverified. **None of these is made mandatory by 2026-07-28 on the pages read.** The ticket allows reconsidering a deferred item when it is required for protocol compliance; this analysis found no such item.

## 6. Experimental extensions (R15)

Listed so that they are not mistaken for missing work. Each is optional and, if ever added, off by default.

| Extension | Status on `https://modelcontextprotocol.io/extensions` | In Trellis |
|---|---|---|
| MCP Apps (`io.modelcontextprotocol/ui`) | Stable (2026-01-26) | supported (section 3) |
| Skills over MCP (`io.modelcontextprotocol/skills`) | Beta, destination not stated; see U-5 | `missing` (`experimental`); T5 |
| MCP Tasks | Beta, to Core | out of scope per ticket |
| OAuth Client Credentials, Enterprise-Managed Authorization | Stable | `missing`; Enterprise-Managed Authorization matches the ticket's "Enterprise-managed identity infrastructure" exclusion, Client Credentials is not named by the ticket and needs the maintainer's decision |
| Server Cards, Events | Beta | out of scope per ticket (Events) / not named (Server Cards) |

## Unverified

Things this analysis could not confirm from a primary page. None is guessed in the tables above.

- **U-1.** Changes between 2025-06-18 and 2025-11-25 are not on any page read; the changelog compares against 2025-11-25 only. Trellis supports 2025-06-18 as its newest version, so some 2025-11-25 changes may also be missing.
- **U-2.** Whether `cacheScope` is required or optional: the caching page lists the allowed values but does not say. `ttlMs` is stated as required on cacheable results.
- **U-3.** The raw MCP schema file (`schema.ts`) was not read; exact field shapes of `DiscoverResult` and the error data come only from examples on the pages.
- **U-4.** The MCP Apps specification file was read through a truncated copy whose tail is a summary; capability negotiation and some MUST/SHOULD levels are marked as summary in the rows that use them. The listing shows MCP Apps at version 2026-01-26 only; there is no 2026-07-28 Apps specification.
- **U-5.** The Skills extension is described as "Beta, destination not yet stated" on the extensions listing and as "SEP-2640 is Final" on its overview page; the two pages disagree and this analysis did not settle which is current. T5 must pin one version before work starts.
- **U-6.** Pages not read: stdio transport, the OAuth Client Credentials and Enterprise-Managed Authorization extension pages, Tasks, Server Cards, Events, and the IETF CIMD draft.
- **U-7.** Test files listed in the matrix were matched by name and by a keyword search; none was run for this matrix. Where a row says a mention is not confirmed, the coverage is unknown.
- **U-8.** Progress notifications and the exact behaviour of `validate.ts` against JSON Schema 2020-12 were not assessed line by line.
