# Next.js SaaS starter

An App Router route that mounts mcp-trellis with `signedTokenAuth`. It is type-checked, not run in CI, and has no `next` dependency. Replace `readSession` in `session.ts` with your real auth (cookie, Auth.js, Better Auth) before deploying.

## Use it

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

Also route `/.well-known/*` to the same handler (a rewrite or a second route), so OAuth metadata reaches mcp-trellis.

## Deploy

1. Install `mcp-trellis` in your Next app.
2. Wire `resolveUser` to your real session (Auth.js, Better Auth, custom cookie).
3. Replace `allowInMemoryCodeStore` with a shared `codeStore` (see [`stores.ts`](../stores.ts)).
4. Deploy behind HTTPS and add `https://YOUR_HOST/mcp` as a connector in Claude or ChatGPT.
5. Check that `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource/mcp` reach the same app.

## Scope

It shows the shape: one catch-all route, one secret, your session. It has no `package.json` and no login UI. For a full walkthrough with Alice, Bob and consent, use [`project-desk`](../project-desk/) ([local docs](../saas-demo/README.md)).
