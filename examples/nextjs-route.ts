/**
 * Next.js App Router route sketch — compile-verified only (`npm run typecheck`).
 * Drop into `app/mcp/[[...path]]/route.ts` (or similar catch-all).
 * No `next` dependency; not executed in CI.
 */

import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/mcp/registry.js";
import { requiredSecret } from "./env.js";
import { signToken, verifyToken } from "./signed-token.js";

type Ctx = { userId: string };

const ACCESS_TOKEN_TTL_MS = 3_600_000;
const CODE_SECRET = requiredSecret("OAUTH_CODE_SECRET");
// Separate from CODE_SECRET — signing access tokens and sealing auth codes are different jobs.
const ACCESS_SECRET = requiredSecret("ACCESS_TOKEN_SECRET");

const ping: ToolDef<Ctx> = {
  name: "ping",
  description: "Health check",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: async () => "ok",
};

const app = createMcpApp<Ctx>({
  serverInfo: { name: "nextjs-example", version: "1.0.0" },
  tools: [ping],
  clients: ["claude"],
  // Demo only — production must pass auth.codeStore (KV/Redis SET NX).
  allowInMemoryCodeStore: true,
  auth: {
    codeSecret: CODE_SECRET,
    // Placeholder: every caller is "u1". Do not ship this — read the caller's
    // real session (e.g. `cookies()` / your auth library) and return null
    // when nobody is logged in.
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (req, next) => `${new URL(req.url).origin}/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async ({ userId, scope, resource }) => ({
      accessToken: await signToken(ACCESS_SECRET, {
        userId,
        scopes: scope.split(" "),
        audience: resource,
        exp: Date.now() + ACCESS_TOKEN_TTL_MS,
      }),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
      scope,
    }),
    verifyToken: async (token) => verifyToken(ACCESS_SECRET, token),
  },
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

export const GET = (request: Request): Promise<Response> => app.fetch(request);
export const POST = (request: Request): Promise<Response> => app.fetch(request);
export const OPTIONS = (request: Request): Promise<Response> => app.fetch(request);
