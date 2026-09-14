/**
 * Next.js App Router route sketch — compile-verified only (`npm run typecheck`).
 * Drop into `app/mcp/[[...path]]/route.ts` (or similar catch-all).
 * No `next` dependency; not executed in CI.
 */

import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/registry.js";
import { signToken, verifyToken } from "./signed-token.js";

type Ctx = { userId: string };

const ACCESS_TOKEN_TTL_MS = 3_600_000;
const CODE_SECRET = "example-nextjs-route-code-secret-do-not-reuse!!";
const ACCESS_SECRET = "example-nextjs-route-access-token-secret-32c!";

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
