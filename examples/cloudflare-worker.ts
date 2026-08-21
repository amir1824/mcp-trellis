/**
 * Cloudflare Worker mount — compile-verified only (`npm run typecheck`).
 * No wrangler / @cloudflare/workers-types; not executed in CI.
 *
 * In production, allowlist `new URL(req.url).origin` when the Worker is
 * bound to a wildcard route (same Host caveat as Node `allowedOrigins`).
 */

import { isAllowedOrigin } from "../src/adapters/origins.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/registry.js";

type Env = {
  OAUTH_CODE_SECRET: string;
};

type Ctx = { userId: string };

type TokenPayload = {
  userId: string;
  scopes: string[];
  audience: string;
};

const ping: ToolDef<Ctx> = {
  name: "ping_db",
  description: "Health check",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: async () => "ok",
};

const encodeToken = (payload: TokenPayload): string =>
  btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const decodeToken = (token: string): TokenPayload | null => {
  try {
    const padded = token.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(padded)) as TokenPayload;
  } catch {
    return null;
  }
};

const buildApp = (env: Env) =>
  createMcpApp<Ctx>({
    serverInfo: { name: "worker-example", version: "1.0.0" },
    tools: [ping],
    clients: ["claude"],
    auth: {
      codeSecret: env.OAUTH_CODE_SECRET,
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: (req, next) => `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, scope, resource }) => ({
        accessToken: encodeToken({
          userId,
          scopes: scope.split(" "),
          audience: resource,
        }),
        expiresIn: 3600,
        scope,
      }),
      verifyToken: async (token) => decodeToken(token),
    },
    context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
  });

const ALLOWED = ["*.mcp.example.com", "https://mcp.example.com"];

type App = ReturnType<typeof buildApp>;
let cached: { secret: string; app: App } | null = null;

const appFor = (env: Env): App => {
  if (cached?.secret === env.OAUTH_CODE_SECRET) return cached.app;
  const app = buildApp(env);
  cached = { secret: env.OAUTH_CODE_SECRET, app };
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
