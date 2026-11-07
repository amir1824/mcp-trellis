/**
 * Multi-tenant SaaS sketch — subdomain Host → tenant, allowlisted origins,
 * and a membership check. Typechecked via examples/ and exercised by
 * test/e2e/multi-tenant.test.ts.
 *
 * Three separate controls, none of which replaces another:
 * - The request Host picks the tenant, and the audience check rejects a token
 *   minted for another tenant's origin.
 * - Membership decides whether this user may get a token for that tenant at
 *   all (checked in `mintAccessToken`) and whether they may use it on each call
 *   (checked in the tool). Audience binding alone proves the token fits the
 *   server, not that the person belongs to the tenant.
 * - Optional bearer `claims` are plan/role metadata only — never the
 *   Host→tenant authorization key (a forged claim with a matching audience
 *   would otherwise scope tools to the wrong tenant).
 *
 * In an app, import from `mcp-trellis` / `mcp-trellis/node`.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { asNodeHandler } from "../src/adapters/node.js";
import { createMcpApp } from "../src/app.js";
import type { ToolDef } from "../src/mcp/registry.js";
import { requiredSecret } from "./env.js";
import { signToken, verifyToken } from "./signed-token.js";

type Ctx = { userId: string; tenantId: string; plan?: string };

const ACCESS_TOKEN_TTL_MS = 3_600_000;
const DEMO_USER_HEADER = "x-demo-user";

const ROWS: Record<string, string[]> = {
  acme: ["invoice-1", "invoice-2"],
  globex: ["po-9"],
};

// Stand-in for your membership table. `Object.hasOwn` on every lookup, so a
// tenant named `constructor` or `toString` is "no members", not an
// Object.prototype member.
const MEMBERS: Record<string, string[]> = {
  acme: ["alice"],
  globex: ["bob"],
};

const isMember = (tenantId: string, userId: string): boolean =>
  Object.hasOwn(MEMBERS, tenantId) && (MEMBERS[tenantId] ?? []).includes(userId);

export const listRows: ToolDef<Ctx> = {
  name: "list_rows",
  description: "List this tenant's rows only",
  inputSchema: { type: "object", properties: {} },
  scope: "mcp",
  // `tenantId` comes from the Host header. A valid token is not enough: the
  // caller must still be a member of that tenant on every call.
  handler: (ctx) => {
    if (!isMember(ctx.tenantId, ctx.userId)) {
      throw new Error(`user ${ctx.userId} is not a member of tenant ${ctx.tenantId}`);
    }
    return JSON.stringify(Object.hasOwn(ROWS, ctx.tenantId) ? ROWS[ctx.tenantId] : []);
  },
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

type Secrets = { codeSecret: string; accessSecret: string };

export const createMultiTenantApp = ({ codeSecret, accessSecret }: Secrets) =>
  createMcpApp<Ctx>({
    serverInfo: { name: "multi-tenant", version: "1.0.0" },
    tools: [listRows],
    clients: ["claude"],
    allowInMemoryCodeStore: true,
    auth: {
      codeSecret,
      // Placeholder: the caller is whoever the demo header names. Never ship
      // this — anyone can send that header. Read the caller's real session and
      // return null when nobody is logged in.
      resolveUser: async (req) => {
        const id = req.headers.get(DEMO_USER_HEADER);
        return id ? { id } : null;
      },
      loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, scope, resource }) => {
        const tenantId = tenantOf(new URL(resource).origin);
        if (!tenantId) throw new Error(`unknown tenant for resource ${resource}`);
        if (!isMember(tenantId, userId)) {
          throw new Error(`user ${userId} is not a member of tenant ${tenantId}`);
        }
        return {
          accessToken: await signToken(accessSecret, {
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
      verifyToken: async (token) => verifyToken(accessSecret, token),
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

const serve = (): void => {
  const app = createMultiTenantApp({
    codeSecret: requiredSecret("OAUTH_CODE_SECRET"),
    // Separate from the code secret — signing access tokens and sealing auth codes are different jobs.
    accessSecret: requiredSecret("ACCESS_TOKEN_SECRET"),
  });
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
};

if (process.argv[1] === fileURLToPath(import.meta.url)) serve();
