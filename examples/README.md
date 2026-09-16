# Examples

## Canonical: Project desk

**[`project-desk/`](project-desk/)** — reference remote MCP server (Official MCP
Registry + `mcp-trellis-project-desk` npm). Local docs:
[`saas-demo/README.md`](saas-demo/README.md).

Two users (Alice / Bob), independent session login, OAuth consent, user-scoped
`list_my_projects`, and instructions for connecting a remote AI client.

```bash
npm run demo
```

## Starters

| Path | What it shows |
|------|----------------|
| [`nextjs-saas/`](nextjs-saas/) | Next.js App Router catch-all + `signedTokenAuth` |
| [`http-server.ts`](http-server.ts) | Raw Node `http.createServer` |
| [`express.ts`](express.ts) | Express / Cloud Run sketch |
| [`cloudflare-worker.ts`](cloudflare-worker.ts) | Minimal Workers recipe (ping); hosted Project desk uses `project-desk/worker.ts` |

## Recipes

| Path | What it shows |
|------|----------------|
| [`multi-tenant.ts`](multi-tenant.ts) | Tenant claims + explicit mint/verify ports |
| [`stores.ts`](stores.ts) | Shared `codeStore` / revocation shapes |
| [`audit-store.ts`](audit-store.ts) | Unified audit sink |
| [`signed-token.ts`](signed-token.ts) | Standalone HMAC helpers for advanced ports |

Prefer `signedTokenAuth` from `mcp-trellis` for new apps; use the advanced
ports when you need refresh, revoke, or your own JWT/JWKS.
