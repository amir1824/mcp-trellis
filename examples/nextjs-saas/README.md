# Next.js SaaS starter

Drop-in App Router route that mounts mcp-trellis with `signedTokenAuth`.
Replace `readSession` in `session.ts` with your real auth (cookie / Auth.js /
Better Auth) before deploying.

## Drop-in path

Copy into a Next.js App Router project:

```
app/mcp/[[...path]]/route.ts   ← contents of route.ts (adjust imports)
lib/mcp-session.ts             ← contents of session.ts (or your auth)
```

In `route.ts`, change imports to:

```ts
import { createMcpApp, signedTokenAuth } from "mcp-trellis";
import { readSession } from "@/lib/mcp-session";
```

Set one secret (≥32 characters):

```bash
export MCP_SECRET="$(openssl rand -base64 32)"
```

Also mount discovery: either proxy `/.well-known/*` to the same handler, or
add matching rewrite rules so OAuth metadata reaches Trellis.

## Deploy

1. Install `mcp-trellis` in your Next app.
2. Wire `resolveUser` to your real session (Auth.js, Better Auth, custom cookie).
3. Replace `allowInMemoryCodeStore` with a shared `codeStore` (Redis / KV) —
   see [`examples/stores.ts`](../stores.ts).
4. Deploy behind HTTPS. Point Claude / ChatGPT at `https://YOUR_HOST/mcp`.
5. Ensure `/.well-known/oauth-authorization-server` and
   `/.well-known/oauth-protected-resource/mcp` reach the same process.

## What this is / isn't

- Shows the integration shape: one catch-all route + one secret + your session.
- Not a full Next app (no `package.json`, no login UI). For the full fictional
  SaaS with Alice/Bob and consent walkthrough, use
  [`examples/saas-demo`](../saas-demo/).
