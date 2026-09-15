/**
 * Multi-tenant SaaS sketch — subdomain Host → tenant, allowlisted origins.
 * Typechecked via examples/; not an e2e fixture.
 *
 * Tenant isolation comes from the request Host (and the audience check on
 * that resource). Optional bearer `claims` are for plan/role metadata only —
 * never the Host→tenant authorization key (a forged claim with a matching
 * audience would otherwise scope tools to the wrong tenant).
 *
 * In an app, import from `mcp-trellis` / `mcp-trellis/node`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/mcp/registry.js";
import { requiredSecret } from "./env.js";
import { signToken, verifyToken } from "./signed-token.js";

type Ctx = { userId: string; tenantId: string; plan?: string };

const ACCESS_TOKEN_TTL_MS = 3_600_000;
const CODE_SECRET = requiredSecret("OAUTH_CODE_SECRET");
// Separate from CODE_SECRET — signing access tokens and sealing auth codes are different jobs.
const ACCESS_SECRET = requiredSecret("ACCESS_TOKEN_SECRET");

const ROWS: Record<string, string[]> = {
  acme: ["invoice-1", "invoice-2"],
  globex: ["po-9"],
};

const listRows: ToolDef<Ctx> = {
  name: "list_rows",
  description: "List this tenant's rows only",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  handler: (ctx) => JSON.stringify(ROWS[ctx.tenantId] ?? []),
};

const tenantOf = (origin: string): string | null => {
  try {
    const host = new URL(origin).hostname;
    const match = /^([a-z0-9-]+)\.mcp\.example\.com$/i.exec(host);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

const app = createMcpApp<Ctx>({
  serverInfo: { name: "multi-tenant", version: "1.0.0" },
  tools: [listRows],
  clients: ["claude"],
  allowInMemoryCodeStore: true,
  auth: {
    codeSecret: CODE_SECRET,
    // Placeholder: every caller is "u1". Do not ship this — read the caller's
    // real session and return null when nobody is logged in.
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async ({ userId, scope, resource }) => {
      const tenantId = tenantOf(new URL(resource).origin);
      if (!tenantId) throw new Error("unknown tenant");
      return {
        accessToken: await signToken(ACCESS_SECRET, {
          userId,
          scopes: scope.split(" "),
          audience: resource,
          exp: Date.now() + ACCESS_TOKEN_TTL_MS,
          claims: { plan: "pro" },
        }),
        expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
        scope,
      };
    },
    verifyToken: async (token) => verifyToken(ACCESS_SECRET, token),
  },
  context: async (req, principal) => {
    const tenantId = tenantOf(new URL(req.url).origin) ?? "";
    const plan = typeof principal?.claims?.plan === "string" ? principal.claims.plan : undefined;
    return {
      userId: principal?.id ?? "",
      tenantId,
      ...(plan !== undefined ? { plan } : {}),
    };
  },
});

const ALLOWED = ["*.mcp.example.com"];

const server = http.createServer();
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  // Local demo: Host header must be an allowlisted tenant subdomain.
  // `trustProxy: true` means the origin comes from X-Forwarded-Host /
  // X-Forwarded-Proto when present. Only deploy this behind a reverse proxy
  // that overwrites those headers on every request — exposed directly, any
  // client can set them. `allowedOrigins` still bounds which tenant origins
  // are accepted, and the audience check still rejects another tenant's token,
  // but a single-origin deployment should pass a fixed `origin` instead.
  const handler = asNodeHandler(app, {
    trustProxy: true,
    allowedOrigins: ALLOWED,
  });
  server.on("request", (req, res) => {
    void handler(req, res);
  });
  process.stdout.write(`listening http://127.0.0.1:${port}\n`);
});
