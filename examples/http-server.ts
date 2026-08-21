/**
 * Runnable Node recipe (`npx tsx examples/http-server.ts`).
 * Also the real-socket e2e fixture — prints `listening http://127.0.0.1:<port>`.
 *
 * In an app, import from `mcp-trellis` / `mcp-trellis/node` instead of `../src`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/registry.js";

type Ctx = { userId: string };

const echo: ToolDef<Ctx> = {
  name: "echo",
  description: "Echo text back",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
  scope: "mcp",
  handler: (_ctx, args) => String(args.text ?? ""),
};

const encodeToken = (payload: { userId: string; scopes: string[]; audience: string }): string =>
  Buffer.from(JSON.stringify(payload)).toString("base64url");

// ponytail: process-local Set; ceiling is a shared denylist that verifyToken
// (and refreshAccessToken) read — see examples/stores.ts for the Kv shape.
const revoked = new Set<string>();

const app = createMcpApp<Ctx>({
  serverInfo: { name: "example", version: "1.0.0" },
  tools: [echo],
  clients: ["claude"],
  auth: {
    // Real deployments: process.env.OAUTH_CODE_SECRET, generated via `openssl rand -base64 32`.
    codeSecret: "example-http-server-code-secret-do-not-reuse",
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async ({ userId, scope, resource }) => ({
      accessToken: encodeToken({
        userId,
        scopes: scope.split(" "),
        audience: resource,
      }),
      expiresIn: 3600,
      scope,
    }),
    verifyToken: async (token) => {
      if (revoked.has(token)) return null;
      try {
        return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
          userId: string;
          scopes: string[];
          audience: string;
        };
      } catch {
        return null;
      }
    },
    revokeToken: async ({ token }) => {
      revoked.add(token);
    },
  },
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

const server = http.createServer();
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const handler = asNodeHandler(app, { origin });
  server.on("request", (req, res) => {
    void handler(req, res);
  });
  process.stdout.write(`listening ${origin}\n`);
});
