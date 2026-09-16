/**
 * Cloudflare Worker mount — compile-verified only (`npm run typecheck`).
 * No wrangler / @cloudflare/workers-types; not executed in CI.
 *
 * In production, allowlist `new URL(req.url).origin` when the Worker is
 * bound to a wildcard route (same Host caveat as Node `allowedOrigins`).
 */

import { createMcpApp } from "../src/app.js";
import { signedTokenAuth } from "../src/auth/signed-token.js";
import { isAllowedOrigin } from "../src/http/origins.js";
import type { ToolDef } from "../src/mcp/registry.js";

type Env = {
  MCP_SECRET: string;
};

type Ctx = { userId: string };

const ping: ToolDef<Ctx> = {
  name: "ping_db",
  description: "Health check",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: async () => "ok",
};

const buildApp = (env: Env) =>
  createMcpApp<Ctx>({
    serverInfo: { name: "worker-example", version: "1.0.0" },
    tools: [ping],
    clients: ["claude"],
    // Demo only — Workers run many isolates; pass a Durable Object / D1
    // codeStore before production (see examples/stores.ts). This flag makes
    // the single-isolate footgun explicit instead of silent.
    allowInMemoryCodeStore: true,
    auth: signedTokenAuth({
      secret: env.MCP_SECRET,
      // resolveUser is a placeholder that always succeeds as one fixed
      // user — this example has no real login system to wire up. A real
      // Worker's resolveUser reads the caller's actual session (its own
      // cookie/JWT, or a call out to your IdP) and returns null when
      // nobody is logged in (→ redirect to loginUrl). Do not ship this
      // fixed-user placeholder — it authenticates every caller as "u1".
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: (req, next) => `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
    }),
    context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
  });

const ALLOWED = ["*.mcp.example.com", "https://mcp.example.com"];

type App = ReturnType<typeof buildApp>;
let cached: { secret: string; app: App } | null = null;

const appFor = (env: Env): App => {
  if (cached?.secret === env.MCP_SECRET) return cached.app;
  const app = buildApp(env);
  cached = { secret: env.MCP_SECRET, app };
  return app;
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!isAllowedOrigin(new URL(req.url).origin, { allowedOrigins: ALLOWED })) {
      return Response.json({ error: "origin not allowed" }, { status: 400 });
    }
    return appFor(env).fetch(req);
  },
};
