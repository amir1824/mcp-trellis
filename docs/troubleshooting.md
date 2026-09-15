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
| Client requests an unsupported protocol | Package supports the revisions in `src/mcp/protocol.ts` | Record negotiation; do not claim a live pass from a successful HTTP status alone. |

See [security responsibilities](security.md) before replacing production token verification with example code. Share sanitized errors in an issue, never access tokens or session cookies.
