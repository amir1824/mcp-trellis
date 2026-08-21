import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp, type McpApp } from "../src/app.js";
import { sha256Base64Url } from "../src/oauth/pkce.js";
import type { ToolDef } from "../src/registry.js";

const ORIGIN = "https://app.test";
const RESOURCE = `${ORIGIN}/mcp`;

type Ctx = { userId: string; tenantId?: string };

const echo: ToolDef<Ctx> = {
  name: "echo",
  description: "Echo text back",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
  },
  scope: "mcp",
  handler: (ctx, args) =>
    ctx.tenantId ? `${ctx.tenantId}:${String(args.text ?? "")}` : String(args.text ?? ""),
};

/** Opaque test token: the app must still enforce the audience itself. */
const encodeToken = (payload: {
  userId: string;
  scopes: string[];
  audience: string;
  claims?: Record<string, unknown>;
}): string => Buffer.from(JSON.stringify(payload)).toString("base64url");

const makeApp = (
  overrides: Partial<{
    audience: string;
    claims: Record<string, unknown>;
  }> = {},
): McpApp =>
  createMcpApp<Ctx>({
    serverInfo: { name: "app-test", version: "1.0.0" },
    tools: [echo],
    clients: ["claude"],
    extraRedirectUris: ["https://client.test/cb"],
    // Invented client_id in the PKCE walk — opt out of 1.0's default lock-down.
    requireRegisteredClients: false,
    auth: {
      codeSecret: "app-test-code-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
      mintAccessToken: async ({ userId, scope, resource }) => ({
        accessToken: encodeToken({
          userId,
          scopes: scope.split(" "),
          audience: overrides.audience ?? resource,
          ...(overrides.claims ? { claims: overrides.claims } : {}),
        }),
        expiresIn: 3600,
      }),
      // Deliberately does NOT check the audience — the library must.
      verifyToken: async (token) => {
        try {
          return JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
            userId: string;
            scopes: string[];
            audience: string;
            claims?: Record<string, unknown>;
          };
        } catch {
          return null;
        }
      },
    },
    context: async (_req, principal) => {
      const tenantId =
        typeof principal?.claims?.tenant_id === "string" ? principal.claims.tenant_id : undefined;
      return {
        userId: principal?.id ?? "",
        ...(tenantId !== undefined ? { tenantId } : {}),
      };
    },
  });

const rpc = (app: McpApp, body: unknown, token?: string) =>
  app.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

/** Walk the real connector path: authorize with PKCE, then redeem the code. */
const getAccessToken = async (app: McpApp): Promise<string> => {
  const verifier = "pkce-verifier-value-that-is-long-enough";
  const challenge = await sha256Base64Url(verifier);
  const redirectUri = "https://client.test/cb";

  const authorizeUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: "client-1",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();

  const authorized = await app.fetch(new Request(authorizeUrl, { method: "GET" }));
  assert.equal(authorized.status, 200, "authorize must render the consent interstitial");
  const html = await authorized.text();
  const ticketMatch = html.match(/name="consent_ticket"\s+value="([^"]+)"/);
  assert.ok(ticketMatch?.[1], "consent page must carry a well-formed consent_ticket");

  const approved = await app.fetch(
    new Request(`${ORIGIN}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        consent_ticket: ticketMatch[1],
        approved: "true",
      }).toString(),
    }),
  );
  assert.equal(approved.status, 302);
  const location = approved.headers.get("location");
  assert.ok(location, "consent approval must redirect");
  const code = new URL(location).searchParams.get("code");
  assert.ok(code, "redirect must carry a code");

  const tokenRes = await app.fetch(
    new Request(`${ORIGIN}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: "client-1",
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    }),
  );
  assert.equal(tokenRes.status, 200);
  const minted = (await tokenRes.json()) as {
    access_token: string;
    scope: string;
  };
  assert.equal(minted.scope, "mcp");
  return minted.access_token;
};

describe("createMcpApp", () => {
  it("serves both discovery documents", async () => {
    const app = makeApp();

    const prm = await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
    assert.equal(prm.status, 200);
    assert.equal(((await prm.json()) as { resource: string }).resource, RESOURCE);

    const as = await app.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
    assert.equal(as.status, 200);
    const meta = (await as.json()) as {
      authorization_endpoint: string;
      token_endpoint_auth_methods_supported: string[];
    };
    assert.equal(meta.authorization_endpoint, `${ORIGIN}/mcp/oauth/authorize`);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
  });

  it("rejects an unauthenticated tools/call with WWW-Authenticate", async () => {
    const app = makeApp();
    const res = await rpc(app, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    });
    assert.equal(res.status, 401);
    const header = res.headers.get("www-authenticate");
    assert.ok(header?.includes("resource_metadata="));
  });

  it("completes authorize → token → tools/call", async () => {
    const app = makeApp();
    const token = await getAccessToken(app);

    const res = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      },
      token,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    assert.equal(body.result.isError, false);
    assert.equal(body.result.content[0]?.text, "hello");
  });

  it("rejects a token minted for another resource", async () => {
    // verifyToken above performs no audience check — the library must.
    const app = makeApp({ audience: "https://other.test/mcp" });
    const token = await getAccessToken(app);

    const res = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      token,
    );
    assert.equal(res.status, 401);
  });

  it("rejects a token minted for another tenant origin", async () => {
    const app = makeApp({ audience: "https://acme.app.test/mcp" });
    const token = await getAccessToken(app);
    const res = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      token,
    );
    assert.equal(res.status, 401);
  });

  it("threads verifyToken claims into context through the PKCE walk", async () => {
    const app = makeApp({ claims: { tenant_id: "acme" } });
    const token = await getAccessToken(app);
    const res = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      },
      token,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    assert.equal(body.result.content[0]?.text, "acme:hello");
  });

  it("leaves claims undefined when the token omits them", async () => {
    const app = makeApp();
    const token = await getAccessToken(app);
    const res = await rpc(
      app,
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      },
      token,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }> };
    };
    assert.equal(body.result.content[0]?.text, "hello");
  });

  it("returns 404 off-route", async () => {
    const app = makeApp();
    const res = await app.fetch(new Request(`${ORIGIN}/nope`));
    assert.equal(res.status, 404);
  });

  it("routes /mcp/ (trailing slash) the same as /mcp, instead of 404ing", async () => {
    const app = makeApp();
    // Unauthenticated on purpose — the point is that this reaches the MCP
    // handler (401, "no bearer") rather than app.ts's own route-miss (404).
    const withSlash = await app.fetch(
      new Request(`${ORIGIN}/mcp/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const withoutSlash = await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.equal(withSlash.status, withoutSlash.status);
    assert.notEqual(withSlash.status, 404);
  });

  it("completes a full authorize → token → tools/call walk against /mcp/ end to end", async () => {
    const app = makeApp();
    const token = await getAccessToken(app);
    const res = await app.fetch(
      new Request(`${ORIGIN}/mcp/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "echo", arguments: { text: "hi" } },
        }),
      }),
    );
    assert.equal(res.status, 200);
  });

  it("locks down to pre-registered clients when only gemini is configured", async () => {
    const app = createMcpApp<Ctx>({
      serverInfo: { name: "gemini-only", version: "1.0.0" },
      tools: [echo],
      clients: ["gemini"],
      auth: {
        codeSecret: "app-test-code-secret-value-32-characters-long",
        resolveUser: async () => ({ id: "u1" }),
        loginUrl: () => "/login",
        mintAccessToken: async ({ userId, scope }) => ({
          accessToken: `token-for-${userId}`,
          expiresIn: 3600,
          scope,
        }),
        verifyToken: async () => null,
        clientStore: {
          get: async (clientId) =>
            clientId === "gemini-client"
              ? {
                  clientId,
                  redirectUris: ["https://gemini.test/cb"],
                  tokenEndpointAuthMethod: "client_secret_basic",
                }
              : null,
          verifySecret: async (_id, presented) => presented === "s3cr3t",
        },
      },
    });

    // DCR is gone — no route to self-register a public client.
    const register = await app.fetch(
      new Request(`${ORIGIN}/mcp/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(register.status, 404);

    // Inventing a client_id and using PKCE alone no longer works.
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "self-issued",
      redirect_uri: "http://127.0.0.1:4000/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const authorize = await app.fetch(new Request(url, { method: "GET" }));
    assert.equal(authorize.status, 400);
    assert.equal(((await authorize.json()) as { error: string }).error, "unauthorized_client");
  });

  it("refuses to construct a pre-registered client without a clientStore", () => {
    assert.throws(
      () =>
        createMcpApp<Ctx>({
          serverInfo: { name: "x", version: "1" },
          tools: [echo],
          clients: ["gemini"],
          auth: {
            codeSecret: "s",
            resolveUser: async () => null,
            loginUrl: () => "/login",
            mintAccessToken: async () => ({
              accessToken: "t",
              expiresIn: 60,
            }),
            verifyToken: async () => null,
          },
        }),
      /clientStore/,
    );
  });

  it("refuses to construct with an empty clients list", () => {
    assert.throws(
      () =>
        createMcpApp<Ctx>({
          serverInfo: { name: "x", version: "1" },
          tools: [echo],
          clients: [],
          auth: {
            codeSecret: "s",
            resolveUser: async () => null,
            loginUrl: () => "/login",
            mintAccessToken: async () => ({
              accessToken: "t",
              expiresIn: 60,
            }),
            verifyToken: async () => null,
          },
        }),
      /at least one connector/,
    );
  });
});
