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
import { signToken, verifyToken } from "./signed-token.js";

type Env = {
  OAUTH_CODE_SECRET: string;
  // A separate secret from OAUTH_CODE_SECRET — signing access tokens and
  // sealing auth codes are different jobs; reusing one key for both means a
  // compromise of either leaks the other's blast radius too.
  ACCESS_TOKEN_SECRET: string;
};

type Ctx = { userId: string };

const ACCESS_TOKEN_TTL_MS = 3_600_000;

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
    auth: {
      codeSecret: env.OAUTH_CODE_SECRET,
      // resolveUser is a placeholder that always succeeds as one fixed
      // user — this example has no real login system to wire up. A real
      // Worker's resolveUser reads the caller's actual session (its own
      // cookie/JWT, or a call out to your IdP) and returns null when
      // nobody is logged in (→ redirect to loginUrl). Do not ship this
      // fixed-user placeholder — it authenticates every caller as "u1".
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: (req, next) => `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, scope, resource }) => ({
        accessToken: await signToken(env.ACCESS_TOKEN_SECRET, {
          userId,
          scopes: scope.split(" "),
          audience: resource,
          exp: Date.now() + ACCESS_TOKEN_TTL_MS,
        }),
        expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
        scope,
      }),
      verifyToken: async (token) => verifyToken(env.ACCESS_TOKEN_SECRET, token),
      // No `codeStore` is passed, so auth codes and consent tickets fall
      // back to the library's process-local in-memory store — fine for a
      // single Worker isolate during development, but Workers can run many
      // concurrent isolates in production, and an isolate can be evicted
      // between requests. Pass a `codeStore` backed by a Durable Object or
      // D1 before deploying — **not** Workers KV alone, which cannot do the
      // atomic single-use check auth-code redemption needs (see
      // `examples/stores.ts`'s `kvCodeStore` docstring).
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
