/** Fictional existing SaaS: session login and project data are independent of MCP. */
import { timingSafeEqual } from "node:crypto";
import { createMcpApp } from "mcp-trellis";
import { createDemoTokenStore, parseScopes, randomOpaqueToken } from "./tokens.js";

export type CreateDemoOptions = {
  origin: string;
  password: string;
  codeSecret: string;
};

const SESSION_COOKIE = "demo_session=";

const projects = [
  {
    owner: "alice",
    name: "Customer portal",
    openTasks: 3,
    nextMilestone: "Invite pilot customers",
  },
  {
    owner: "alice",
    name: "Billing migration",
    openTasks: 7,
    nextMilestone: "Review migration checklist",
  },
  {
    owner: "bob",
    name: "Internal analytics",
    openTasks: 2,
    nextMilestone: "Validate dashboard data",
  },
];
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

export function createDemo(options: CreateDemoOptions) {
  const origin = new URL(options.origin).origin;
  if (options.password.length < 12)
    throw new Error("DEMO_PASSWORD must have at least 12 characters");
  const sessions = new Map<string, { userId: string; expires: number }>();
  const tokenStore = createDemoTokenStore();
  const session = (request: Request) => {
    const sessionToken = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(SESSION_COOKIE))
      ?.slice(SESSION_COOKIE.length);
    const found = sessionToken ? sessions.get(sessionToken) : undefined;
    return found && found.expires > Date.now() ? { id: found.userId } : null;
  };
  const userProjects = (userId: string) => projects.filter((project) => project.owner === userId);
  const html = (body: string) =>
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Project desk · MCP demo</title><style>body{font:18px system-ui;max-width:760px;margin:64px auto;padding:24px;color:#17332d;background:#f5f6f0}h1{font-size:42px}label{display:block;margin:16px 0}input,select,button{font:inherit;padding:10px}article{border-top:1px solid #bec9c1;padding:18px 0}small{color:#52645b}a{color:#17624e}</style><small>PROJECT DESK / FICTIONAL DEMO DATA</small>${body}</html>`,
      {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  const mcp = createMcpApp<{ userId: string }>({
    serverInfo: { name: "Project desk", version: "1.0.0" },
    clients: ["claude", "codex"],
    scopes: ["mcp", "admin"],
    defaultScopes: ["mcp"],
    context: (_request, principal) => ({ userId: principal?.id ?? "" }),
    tools: [
      {
        name: "list_my_projects",
        description: "List the signed-in user's projects, open tasks and next milestones.",
        inputSchema: { type: "object", properties: {} },
        scope: "mcp",
        handler: ({ userId }) => JSON.stringify(userProjects(userId)),
      },
      {
        // Advertised so refresh-scope escalation e2e can request a broader
        // grant the token store must reject; not used by the demo UI.
        name: "admin_ping",
        description: "Admin health check (demo only).",
        inputSchema: { type: "object", properties: {} },
        scope: "admin",
        handler: () => "ok",
      },
    ],
    allowInMemoryCodeStore: true,
    auth: {
      codeSecret: options.codeSecret,
      resolveUser: async (request) => session(request),
      loginUrl: (_request, next) => `/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, clientId, scope, resource }) =>
        tokenStore.mintPair({
          userId,
          clientId,
          scopes: parseScopes(scope),
          audience: resource,
        }),
      refreshAccessToken: async ({ refreshToken, clientId, resource, scope }) =>
        tokenStore.refresh({
          refreshToken,
          clientId,
          resource,
          ...(scope !== undefined ? { scope } : {}),
        }),
      verifyToken: async (token) => tokenStore.verifyAccess(token),
    },
  });
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (url.pathname === "/login") {
        const candidate = new URL(url.searchParams.get("next") ?? "/", origin);
        const next = candidate.origin === origin ? candidate.pathname + candidate.search : "/";
        if (request.method === "GET")
          return html(
            `<h1>Sign in to Project desk</h1><p>Your existing app session will also identify you during MCP authorization.</p><form method="post" action="/login?${escapeHtml(new URLSearchParams({ next }).toString())}"><label>User <select name="user"><option>alice</option><option>bob</option></select></label><label>Demo password <input name="password" type="password" required></label><button>Sign in</button></form>`,
          );
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        if (request.headers.get("origin") !== origin)
          return new Response("Invalid origin", { status: 403 });
        const form = await request.formData();
        const supplied = Buffer.from(String(form.get("password") ?? ""));
        const expected = Buffer.from(options.password);
        const user = String(form.get("user"));
        if (
          !["alice", "bob"].includes(user) ||
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          return new Response("Invalid credentials", { status: 401 });
        const sessionToken = randomOpaqueToken();
        sessions.set(sessionToken, { userId: user, expires: Date.now() + 3600_000 });
        return new Response(null, {
          status: 303,
          headers: {
            Location: next,
            "Set-Cookie": `${SESSION_COOKIE}${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${origin.startsWith("https:") ? "; Secure" : ""}`,
            "Cache-Control": "no-store",
          },
        });
      }
      if (url.pathname === "/" && request.method === "GET") {
        const user = session(request);
        if (!user) return Response.redirect(`${origin}/login`, 302);
        return html(
          `<h1>${escapeHtml(user.id)}'s projects</h1><p>The MCP tool reads these same records using your authenticated identity.</p>${userProjects(
            user.id,
          )
            .map(
              (project) =>
                `<article><h2>${escapeHtml(project.name)}</h2><p>${project.openTasks} open tasks · ${escapeHtml(project.nextMilestone)}</p></article>`,
            )
            .join(
              "",
            )}<p>Connector URL: <code>${escapeHtml(origin)}/mcp</code></p><a href="/login">Switch demo account</a>`,
        );
      }
      return mcp.fetch(request);
    },
  };
}
