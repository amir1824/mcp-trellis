# Examples

Every `.ts` file here is type-checked by `npm run typecheck`. Import from `mcp-trellis` in your own app; the examples import `../src` so they run against this checkout.

## Reference server

[`project-desk/`](project-desk/) is a runnable remote MCP server: app login, OAuth consent, a user-scoped `list_my_projects` tool, and an opaque token store with refresh rotation. It is also the Official MCP Registry entry and the `mcp-trellis-project-desk` npm package. Local run and client steps: [`saas-demo/README.md`](saas-demo/README.md).

```bash
npm run demo
```

## Starters

| Path | What it shows |
|------|---------------|
| [`nextjs-saas/`](nextjs-saas/) | Next.js App Router route with `signedTokenAuth` (type-checked only) |
| [`http-server.ts`](http-server.ts) | Raw Node `http.createServer` with `asNodeHandler`; the fixture for `test/e2e/http.test.ts` |
| [`express.ts`](express.ts) | Express / Cloud Run mount sketch (type-checked only) |
| [`cloudflare-worker.ts`](cloudflare-worker.ts) | Minimal Workers mount (type-checked only); the hosted Project desk uses `project-desk/worker.ts` |

## Recipes

| Path | What it shows |
|------|---------------|
| [`resources-app.ts`](resources-app.ts) | General resources and an MCP App with its text fallback, two users with different access; booted by `test/resources-example.test.ts` |
| [`multi-tenant.ts`](multi-tenant.ts) | Host to tenant, membership check at mint and on every call, explicit mint and verify ports; run by `test/e2e/multi-tenant.test.ts` |
| [`stores.ts`](stores.ts) | Shared `codeStore` and revocation list over a TTL key-value interface |
| [`audit-store.ts`](audit-store.ts) | A unified `audit` sink: ring buffer and a database-shaped sketch |
| [`signed-token.ts`](signed-token.ts) | HMAC bearer helpers for hand-wired `mintAccessToken` / `verifyToken` (used by `multi-tenant.ts`) |
| [`env.ts`](env.ts) | `requiredSecret`: reads a secret from the environment and refuses to start without it |

Use `signedTokenAuth` for new apps. Wire the ports by hand only when you need tokens revocable before they expire, refresh-token families, or your own JWT/JWKS.
