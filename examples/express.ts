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

const mcp = createMcpApp<Ctx>({
  serverInfo: { name: "express-example", version: "1.0.0" },
  tools: [ping],
  clients: ["claude"],
  // Demo only — production must pass auth.codeStore (KV/Redis SET NX).
  allowInMemoryCodeStore: true,
  auth: {
    codeSecret: CODE_SECRET,
    // Placeholder: every caller is "u1". Do not ship this — read the caller's
    // real session (cookie/JWT) and return null when nobody is logged in.
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
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

/** Drop onto Express / Cloud Functions / Cloud Run as `(req, res) => …`. */
export const handler = asNodeHandler(mcp, {
  origin: process.env.MCP_PUBLIC_ORIGIN ?? "http://127.0.0.1:3000",
});
