# OAuth and CIMD review for mcp-trellis 3.4.0 (SCRUM-25, slice T3)

Status: **Proposed.** Prepared 2026-11-25 against `src/` at commit `7858d3a` plus the T3 changes. "Enforced" means a line of source does it and a test pins it; where a claim was not read in full the text says so. This is a code review against the spec requirements named in each row, not a certification.

## OAuth

| Requirement | Where enforced | Pinned by |
|---|---|---|
| PKCE with S256 only | `src/oauth/endpoints/authorize.ts:211-219` rejects any other method and a challenge that is not 43 base64url characters; the verifier is checked at redemption (`src/oauth/policy/authcode.ts`) | `test/oauth/endpoints/authorize.test.ts`, `test/oauth/endpoints/token.test.ts` |
| Resource indicator bound at authorize and token | `authorize.ts` binds `resource` into the sealed code; `token.ts` and `policy/authcode.ts` compare it on redemption and on refresh | `token.test.ts`, `test/auth/signed-refresh.test.ts` |
| Token audience checked on every MCP request | `src/app.ts:60-64` rejects a token whose audience is not this server's canonical resource. With bare `createMcpHandler` the check is the host's | `test/security/session.test.ts` (R3 R11), `test/mcp/invalid-token.test.ts` |
| Exact redirect URI match | `authorize.ts:51` and `policy/authcode.ts` | `authorize.test.ts`, `token.test.ts` |
| Refresh token rotation and single use | `src/auth/signed/refresh.ts` burns the token in `codeStore` after the checks, so a wrong-client or wrong-resource attempt cannot spend it | `test/auth/signed-refresh.test.ts` |
| Consent bound to the resolved user | `src/oauth/endpoints/consent/handler.ts`: single-use sealed ticket, re-checked against the user at redemption | `test/oauth/endpoints/consent/` |
| `state` and `iss` | `state` is echoed and length-capped; `iss` is added to every callback, and `authorization_response_iss_parameter_supported` is advertised | `test/oauth/endpoints/` |
| Revocation | `/revoke` burns refresh tokens; a signed access token stays valid until `exp` unless the host supplies `isUserActive` or a `verifyToken` denylist | `test/security/session.test.ts` (R10), `test/mcp/invalid-token.test.ts` |

Not confirmed in this review: the `/token` re-resolution of a CIMD client (`src/oauth/crypto/clientauth.ts`) was read but not exercised beyond its existing tests; `scopes_supported` is not tied to the protected resource metadata `scope`; `register.ts` and `sealed.ts` were not read in full.

## CIMD

| Concern | Before this slice | After |
|---|---|---|
| Scheme, credentials, fragment | https only, no credentials, no fragment (`url-guard.ts`, `cimd.ts`) | unchanged |
| Address forms: decimal, hex, octal, short IPv4, IPv4-mapped IPv6, metadata addresses, `localhost.` | refused by `cimd-ssrf.ts` | unchanged, now pinned by a table in `test/oauth/cimd/hardening.test.ts` |
| Resolved addresses | every answer checked, before the request and again after the body | unchanged |
| Redirects | manual, at most 3, same origin only, every hop re-checked | unchanged; a same-origin hop to an address that now resolves privately and an https to http hop are pinned by tests |
| Ports | any port was fetched | opt-in `cimdAllowedPorts` |
| Content-Type | never checked | opt-in `cimdRequireJsonContentType` |
| Size and time | 5 KB streamed cap, 10 s per hop covering the body, DNS 5 s and 8 at once | unchanged |
| `client_id` equals the document URL | enforced (`cimd-parse.ts`) | unchanged |
| DNS rebinding between the check and the connect | **not pinned** | opt-in `cimdFetch` lets a Node host pin; without it the risk below remains |
| Cache | public document keyed by `client_id`, at most one hour | unchanged; a changed `redirect_uris` stays valid until expiry (pinned, documented) |

**Residual risk, accepted by the maintainer in this slice's plan (Q2).** A resolver that answers with a public address for the check and a private address for the connect can cause one blind GET to an internal host. The response must parse as a CIMD document whose `client_id` equals its URL, and the caller sees only a generic error, so the impact is a request, not data. The second check after the body detects a flip but cannot undo the request (`test/oauth/cimd/hardening.test.ts` pins exactly this). On a Cloudflare Worker the default lookup is unavailable and CIMD fails closed unless the host passes `cimdLookup`.

## Deviations and what was left as it is

| Finding | Decision |
|---|---|
| A missing `code_challenge_method` is read as S256 (`authorize.ts:213-215`), where OAuth 2.1 requires the parameter | Left. Clients that rely on it keep working, and no weaker method is accepted. Revisit in a major release |
| `visibility` on a tool's UI metadata is validated and listed but not enforced: a call from an MCP App is a plain `tools/call` with the same scope check | Left, documented. `test/security/ui-and-docs.test.ts` (R14) pins that the scope check applies and that visibility is not an access rule |
| A `tools/call` for a hidden tool answers `403` and names the scope when `hideToolsOutsideScope` is `true`, while `resources/read` answers as unknown | `"strict"` added so a hidden tool answers as unknown. `true` is unchanged because the `403` carries the step-up challenge clients use to re-consent |
| Tool error text is copied into the audit entry (clipped to 1000 characters) | Left, documented in `docs/security.md`: redact tenant data with `onToolError` |
| The CIMD cache keeps old `redirect_uris` for up to an hour | Left, documented |
| `server/discover` is public by default and shows `capabilities` and `instructions` to an anonymous caller | Left: `initialize` already does the same and is public by default. A host can take it off `publicMethods` |
| The Worker example is compile-checked only | Not verified at run time; reported as such |

## New public options

Each is the smallest way to meet the requirement, reuses an existing component, and defaults to the old behaviour.

| Option | Requirement | Reuse |
|---|---|---|
| `cimdFetch` | close DNS rebinding where the platform allows | `CimdFetchOptions.fetch` already existed for tests; the option passes it through |
| `cimdAllowedPorts` | narrow what a client URL can reach | one rule in `assertSafeUrl` |
| `cimdRequireJsonContentType` | refuse a document served as something else | one check in the body reader; reuses the `not_json` failure code |
| `hideToolsOutsideScope: "strict"` | unauthorized discovery of a tool | widens an existing option; one branch in `missingScopeResponse` |

## Release A, slice T3: acceptance criteria and rollback

- The eight negative tests of the ticket exist in `test/security/` and `test/oauth/cimd/hardening.test.ts` and pass; the Skills half of the last one waits for T5.
- Token audience, scope and revocation answers are unchanged for an existing configuration.
- No runtime dependency, no required option, no default changed.
- Open after this slice: edge execution is not verified, the regression budgets are Proposed, not approved, and the Skills criterion waits for T5.
- Rollback: remove the new options, or revert the commit. Nothing is stored.
