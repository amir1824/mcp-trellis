/**
 * Runnable Node recipe:
 *
 *   OAUTH_CODE_SECRET="$(openssl rand -base64 32)" \
 *   ACCESS_TOKEN_SECRET="$(openssl rand -base64 32)" \
 *   npx tsx examples/http-server.ts
 *
 * Also the real-socket e2e fixture — prints `listening http://127.0.0.1:<port>`.
 *
 * `resolveUser` below is a fixed-user placeholder: every caller is "u1". That
 * is only acceptable on loopback, so binding any other HOST refuses to start
 * unless ALLOW_INSECURE_DEMO=1 states that you accept an unauthenticated server.
 *
 * In an app, import from `mcp-trellis` / `mcp-trellis/node` instead of `../src`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/mcp/registry.js";
import { requiredSecret } from "./env.js";
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
const CODE_SECRET = requiredSecret("OAUTH_CODE_SECRET");
// A separate secret from CODE_SECRET — signing access tokens and sealing auth
// codes are different jobs; reusing one key for both means a compromise of
// either leaks the other's blast radius too.
const ACCESS_SECRET = requiredSecret("ACCESS_TOKEN_SECRET");

const host = process.env.HOST ?? "127.0.0.1";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
if (!LOOPBACK_HOSTS.has(host) && process.env.ALLOW_INSECURE_DEMO !== "1") {
  throw new Error(
    `HOST=${host} would expose a demo that authenticates every caller as "u1". ` +
      "Bind to 127.0.0.1, wire a real resolveUser, or set ALLOW_INSECURE_DEMO=1.",
  );
}

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
    codeSecret: CODE_SECRET,
    // resolveUser is a placeholder that always succeeds as one fixed user —
    // this example has no real login system to wire up. A real app's
    // resolveUser reads the caller's actual session/cookie and returns null
    // when nobody is logged in (→ redirect to loginUrl). Do not ship this
    // fixed-user placeholder — it authenticates every caller as "u1".
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
    verifyToken: async (token) => {
      if (revoked.has(token)) return null;
      return verifyToken(ACCESS_SECRET, token);
    },
    revokeToken: async ({ token }) => {
      revoked.add(token);
    },
  },
  context: async (_req, principal) => ({ userId: principal?.id ?? "" }),
});

const server = http.createServer();
server.listen(Number(process.env.PORT ?? 0), host, () => {
  const { port } = server.address() as AddressInfo;
  const origin = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
  const handler = asNodeHandler(app, { origin });
  server.on("request", (req, res) => {
    void handler(req, res);
  });
  process.stdout.write(`listening ${origin}\n`);
});
