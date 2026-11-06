# Connector troubleshooting

| Symptom | Check | Next step |
|---|---|---|
| Client cannot discover auth | Is `/.well-known/oauth-protected-resource/mcp` reachable on the public origin? | Route discovery paths and `/mcp/oauth/*` through the same proxy as `/mcp`. |
| Discovery advertises localhost | Node adapter origin differs from public URL | Set the exact public HTTPS origin; restart the app. |
| `invalid_client` | Missing registration, wrong configured profile, or missing `clientStore` | Use DCR for public clients or resolve the pre-registered client; keep registration enforcement on. |
| Callback rejected | Callback is not an exact allowlisted URI | Add the callback shown by the client to `extraRedirectUris`; do not allow arbitrary hosts. |
| Browser shows an approval page | A login session exists but consent is still required | Approve in the browser. Do not expect `/authorize` to redirect immediately. |
| Login loops | Cookie domain/path/Secure flags do not match public host | Inspect your app's session handling and use a consistent origin. |
| `invalid_grant` | Expired/replayed code, wrong verifier or resource | Start a fresh authorization flow. Keep verifier and resource consistent. |
| Tool request returns 401 | Token expired, verification failed, or audience mismatch | Verify signature/expiry in app auth and return the requested MCP audience. |
| Tool request returns 403 | Tool scope missing | Grant and return the required scopes from token verification. |
| Wrong user's data | Data query ignores authenticated identity | Filter by verified principal and tenant; never trust a tool argument for ownership. |
| Switching login does not switch connector user | Connector retains its previously issued token | Disconnect and reauthorize with the intended account. |
| Initialization works but tools fail | Initialize is public | Test authenticated `tools/call`; initialize alone proves no auth flow. |
| `unauthorized_client: CIMD client_id could not be resolved` | The connector is told one generic error on purpose; the cause is in your audit sink | Read the `cimd_resolve_failed` entry: `reason` is `<code>[: detail] (authorize\|token/revoke)`. `http_status: status 403` = the document host refused the fetch; `auth_method_unsupported` = its document excludes `none`; `dns_failed (ENOTFOUND)` / `dns_unavailable` = no DNS from this runtime, pass `cimdLookup`; `blocked_address` = it resolves to a non-public address; `timeout` = the host did not answer, or stalled mid-body, within 10 s. Pass `cimdCache` so refresh does not re-fetch. |
| Connector asks to reconnect about every hour | The access token expired and there is no refresh token (`signedTokenAuth` default) | Set `refreshTtlSeconds` with `codeStore` and `isUserActive`, or raise `ttlSeconds`. See [Sessions and expiry](security.md#sessions-and-expiry) |
| `401` with `error="invalid_token"` | A bearer token was sent and rejected: bad signature, expired, wrong audience, or `isUserActive` returned false. The code is the same for all four on purpose | Reconnect. Check expiry and audience first; read your `isUserActive` if the user was valid |
| A removed or disabled user can still use the connector | Tokens are stateless; nothing re-checks the user | Pass `isUserActive` to `signedTokenAuth`. It runs on every request and refresh |
| Approve shows "This approval request expired" / "Your sign-in changed or expired" / "already submitted" | Ticket older than 5 minutes, the app session ended before Approve, or the form was posted twice | Start the connection again from the connector. A caller that does not send `Accept: text/html` gets the JSON error instead |
| `refresh_token` returns `unsupported_grant_type` | `refreshTtlSeconds` is not set (or the host supplied no `refreshAccessToken`) | Enable it as above |
| Client says connected but nothing works after rotating `secret` | `secret` was replaced, not extended: every token and DCR `client_id` signed with the old one stopped verifying | Pass `secret: [new, old]` first, drop `old` after its tokens expire |
| Client requests an unsupported protocol | Package supports the revisions in `src/mcp/protocol.ts` | Record negotiation; do not claim a live pass from a successful HTTP status alone. |

See [security responsibilities](security.md) before replacing production token verification with example code. Share sanitized errors in an issue, never access tokens or session cookies.
