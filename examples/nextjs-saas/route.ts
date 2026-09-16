/**
 * Next.js App Router catch-all — compile-verified only (`npm run typecheck`).
 * Drop into `app/mcp/[[...path]]/route.ts` (or similar).
 *
 * No `next` dependency; not executed in CI. Import from `mcp-trellis` in a
 * real app instead of `../../src`.
 */

import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed-token.js";
import type { ToolDef } from "../../src/mcp/registry.js";
import { requiredSecret } from "../env.js";
import { readSession } from "./session.js";

type Ctx = { userId: string };

const SECRET = requiredSecret("MCP_SECRET");

const listProjects: ToolDef<Ctx> = {
  name: "list_my_projects",
  description: "List the signed-in user's projects",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: async ({ userId }) => JSON.stringify([{ owner: userId, name: "Sample project" }]),
};

const app = createMcpApp<Ctx>({
  serverInfo: { name: "nextjs-saas", version: "1.0.0" },
  tools: [listProjects],
  clients: ["claude"],
  // Demo only — production must pass auth.codeStore (KV/Redis SET NX).
  allowInMemoryCodeStore: true,
  auth: signedTokenAuth({
    secret: SECRET,
    resolveUser: async (request) => readSession(request),
    loginUrl: (request, next) =>
      `${new URL(request.url).origin}/login?next=${encodeURIComponent(next)}`,
  }),
  context: async (_request, principal) => ({ userId: principal?.id ?? "" }),
});

export const GET = (request: Request): Promise<Response> => app.fetch(request);
export const POST = (request: Request): Promise<Response> => app.fetch(request);
export const OPTIONS = (request: Request): Promise<Response> => app.fetch(request);
