/**
 * Multi-tenant SaaS sketch — subdomain Host → tenant, allowlisted origins.
 * Typechecked via examples/; not an e2e fixture.
 *
 * Tenant isolation comes from the request Host (and the audience check on
 * that resource). Optional bearer `claims` are for plan/role metadata only —
 * never the Host→tenant authorization key (a forged claim with a matching
 * audience would otherwise scope tools to the wrong tenant).
 *
 * Demo tokens are unsigned base64 JSON — forgeable. Production must use
 * signed, server-issued tokens (JWT/JWS).
 *
 * In an app, import from `mcp-trellis` / `mcp-trellis/node`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/registry.js";

type Ctx = { userId: string; tenantId: string; plan?: string };

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

const encodeToken = (payload: {
  userId: string;
  scopes: string[];
  audience: string;
  claims?: { plan?: string };
}): string => Buffer.from(JSON.stringify(payload)).toString("base64url");

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
  auth: {
    codeSecret: "multi-tenant-code-secret",
    resolveUser: async () => ({ id: "u1" }),
    loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    mintAccessToken: async ({ userId, scope, resource }) => {
      const tenantId = tenantOf(new URL(resource).origin);
      if (!tenantId) throw new Error("unknown tenant");
      return {
        accessToken: encodeToken({
          userId,
          scopes: scope.split(" "),
          audience: resource,
          claims: { plan: "pro" },
        }),
        expiresIn: 3600,
        scope,
      };
    },
    verifyToken: async (token) => {
      try {
        return JSON.parse(
          Buffer.from(token, "base64url").toString("utf8"),
        ) as {
          userId: string;
          scopes: string[];
          audience: string;
          claims?: { plan?: string };
        };
      } catch {
        return null;
      }
    },
  },
  context: async (req, principal) => {
    const tenantId = tenantOf(new URL(req.url).origin) ?? "";
    const plan =
      typeof principal?.claims?.plan === "string"
        ? principal.claims.plan
        : undefined;
    return { userId: principal?.id ?? "", tenantId, plan };
  },
});

const ALLOWED = ["*.mcp.example.com"];

const server = http.createServer();
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address() as AddressInfo;
  // Local demo: Host header must be an allowlisted tenant subdomain.
  const handler = asNodeHandler(app, {
    trustProxy: true,
    allowedOrigins: ALLOWED,
  });
  server.on("request", (req, res) => {
    void handler(req, res);
  });
  process.stdout.write(`listening http://127.0.0.1:${port}\n`);
});
