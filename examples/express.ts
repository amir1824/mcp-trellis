/**
 * Express mount sketch — compile-verified only (`npm run typecheck`).
 * Uses `asNodeHandler`; no `express` dependency; not executed in CI.
 *
 *   import express from "express";
 *   const app = express();
 *   app.use(express.json());
 *   app.use(express.urlencoded({ extended: false }));
 *   app.all("/mcp*", handler);
 */

import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import { signedTokenAuth } from "../src/auth/signed-token.js";
import type { ToolDef } from "../src/mcp/registry.js";
import { requiredSecret } from "./env.js";

type Ctx = { userId: string };

const SECRET = requiredSecret("MCP_SECRET");

const ping: ToolDef<Ctx> = {
  name: "ping",
  description: "Health check",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: async () => "ok",
};

const mcp = createMcpApp<Ctx>({
  serverInfo: { name: "express-example", version: "1.0.0" },
  tools: [ping],
  clients: ["claude"],
  // Demo only — production must pass auth.codeStore (KV/Redis SET NX).
  allowInMemoryCodeStore: true,
  auth: signedTokenAuth({
    secret: SECRET,
    // Placeholder: every caller is "u1". Do not ship this — read the caller's
    // real session (cookie/JWT) and return null when nobody is logged in.
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
  }),
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

/** Drop onto Express / Cloud Functions / Cloud Run as `(req, res) => …`. */
export const handler = asNodeHandler(mcp, {
  origin: process.env.MCP_PUBLIC_ORIGIN ?? "http://127.0.0.1:3000",
});
