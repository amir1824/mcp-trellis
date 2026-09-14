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
import { signToken, verifyToken } from "./signed-token.js";

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

const ACCESS_TOKEN_TTL_MS = 3_600_000;

// ponytail: process-local Set; ceiling is a shared denylist that verifyToken
// (and refreshAccessToken) read — see examples/stores.ts for the Kv shape.
const revoked = new Set<string>();

const app = createMcpApp<Ctx>({
  serverInfo: { name: "example", version: "1.0.0" },
  tools: [echo],
  clients: ["claude"],
  // Single-process demo — production must pass auth.codeStore (KV/Redis SET NX).
  allowInMemoryCodeStore: true,
  auth: {
    // Real deployments: process.env.OAUTH_CODE_SECRET, generated via `openssl rand -base64 32`.
    codeSecret: "example-http-server-code-secret-do-not-reuse",
    // resolveUser is a placeholder that always succeeds as one fixed user —
    // this example has no real login system to wire up. A real app's
    // resolveUser reads the caller's actual session/cookie and returns null
    // when nobody is logged in (→ redirect to loginUrl).
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    // A separate secret from codeSecret above — signing access tokens and
    // sealing auth codes are different jobs; reusing one key for both means
    // a compromise of either leaks the other's blast radius too.
    mintAccessToken: async ({ userId, scope, resource }) => ({
      accessToken: await signToken("example-http-server-access-token-secret-32c!", {
        userId,
        scopes: scope.split(" "),
        audience: resource,
        exp: Date.now() + ACCESS_TOKEN_TTL_MS,
      }),
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
      scope,
    }),
    verifyToken: async (token) => {
      if (revoked.has(token)) return null;
      return verifyToken("example-http-server-access-token-secret-32c!", token);
    },
    revokeToken: async ({ token }) => {
      revoked.add(token);
    },
  },
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

const server = http.createServer();
const host = process.env.HOST ?? "127.0.0.1";
server.listen(Number(process.env.PORT ?? 0), host, () => {
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const handler = asNodeHandler(app, { origin });
  server.on("request", (req, res) => {
    void handler(req, res);
  });
  process.stdout.write(`listening ${origin}\n`);
});
