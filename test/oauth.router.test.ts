import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url } from "../src/oauth/pkce.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { CLAUDE_CALLBACK } from "../src/oauth/redirect.js";

const RESOURCE = "https://example.test/mcp";

const basePorts = {
  codeSecret: "secret",
  resolveUser: async () => ({ id: "u1" }),
  loginUrl: () => "https://example.test/login",
  mintAccessToken: async () => ({
    accessToken: "tok",
    expiresIn: 3600,
  }),
};

describe("oauth router grant advertisement", () => {
  it("omits refresh_token when handler not provided", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request(
        "https://example.test/.well-known/oauth-authorization-server/mcp",
      ),
    );
    assert.ok(res);
    const body = (await res.json()) as {
      grant_types_supported: string[];
      resource_parameter_supported: boolean;
    };
    assert.deepEqual(body.grant_types_supported, ["authorization_code"]);
    assert.equal(body.resource_parameter_supported, true);
  });

  it("advertises refresh_token when handler provided", async () => {
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        refreshAccessToken: async () => ({
          accessToken: "tok2",
          expiresIn: 3600,
        }),
      },
    });
    const res = await router.tryHandle(
      new Request(
        "https://example.test/.well-known/oauth-authorization-server",
      ),
    );
    assert.ok(res);
    const body = (await res.json()) as {
      grant_types_supported: string[];
    };
    assert.deepEqual(body.grant_types_supported, [
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("authorize → token mints user-bound access token with resource", async () => {
    const verifier = "oauth-flow-verifier-abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    let mintedUser: string | null = null;
    let mintedResource: string | null = null;

    const router = createOAuthRouter({
      ports: {
        codeSecret: "flow-secret",
        resolveUser: async () => ({ id: "admin" }),
        loginUrl: () => "https://example.test/login",
        mintAccessToken: async ({ userId, clientId, resource }) => {
          mintedUser = userId;
          mintedResource = resource;
          return {
            accessToken: `bound-${userId}-${clientId}`,
            expiresIn: 3600,
          };
        },
      },
    });

    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "cid-1");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);
    authUrl.searchParams.set("state", "xyz");

    const authRes = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(authRes);
    assert.equal(authRes.status, 302);
    const location = authRes.headers.get("Location");
    assert.ok(location);
    const redirected = new URL(location);
    const code = redirected.searchParams.get("code");
    assert.ok(code);
    assert.equal(redirected.searchParams.get("state"), "xyz");

    const tokenRes = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_CALLBACK,
          client_id: "cid-1",
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(tokenRes);
    assert.equal(tokenRes.status, 200);
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
    };
    assert.equal(mintedUser, "admin");
    assert.equal(mintedResource, RESOURCE);
    assert.equal(tokenBody.access_token, "bound-admin-cid-1");
    assert.equal(tokenBody.token_type, "bearer");
  });

  it("rejects authorize without resource", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "c");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", "abc");
    authUrl.searchParams.set("code_challenge_method", "S256");
    const res = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });

  it("rejects authorize with wrong resource", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "c");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", "abc");
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", "https://evil.test/mcp");
    const res = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_target");
  });

  it("rejects token with wrong resource", async () => {
    const verifier = "oauth-flow-verifier-abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        codeSecret: "flow-secret",
        resolveUser: async () => ({ id: "admin" }),
      },
    });

    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "cid-1");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);
    const authRes = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(authRes);
    const code = new URL(authRes.headers.get("Location")!).searchParams.get(
      "code",
    );
    assert.ok(code);

    const tokenRes = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: CLAUDE_CALLBACK,
          client_id: "cid-1",
          code_verifier: verifier,
          resource: "https://evil.test/mcp",
        }),
      }),
    );
    assert.ok(tokenRes);
    assert.equal(tokenRes.status, 400);
    const body = (await tokenRes.json()) as { error: string };
    assert.equal(body.error, "invalid_target");
  });

  it("rejects token without resource", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "x",
          redirect_uri: CLAUDE_CALLBACK,
          client_id: "cid-1",
          code_verifier: "v",
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
  });

  it("refresh grant passes resource to port", async () => {
    let refreshedResource: string | null = null;
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        refreshAccessToken: async ({ resource }) => {
          refreshedResource = resource;
          return { accessToken: "refreshed", expiresIn: 3600 };
        },
      },
    });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "rt",
          client_id: "cid",
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(refreshedResource, RESOURCE);
  });

  it("authorize redirects to login when no user", async () => {
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        resolveUser: async () => null,
        loginUrl: (_req, next) =>
          `https://example.test/login?next=${encodeURIComponent(next)}`,
      },
    });
    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "c");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", "abc");
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);
    const res = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(res);
    assert.equal(res.status, 302);
    assert.ok(res.headers.get("Location")?.startsWith("https://example.test/login?"));
  });

  it("authorize resolves relative loginUrl against origin", async () => {
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        resolveUser: async () => null,
        loginUrl: (_req, next) =>
          `/login?next=${encodeURIComponent(next)}`,
      },
    });
    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", "c");
    authUrl.searchParams.set("redirect_uri", CLAUDE_CALLBACK);
    authUrl.searchParams.set("code_challenge", "abc");
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", RESOURCE);
    const res = await router.tryHandle(new Request(authUrl.toString()));
    assert.ok(res);
    assert.equal(res.status, 302);
    assert.ok(
      res.headers.get("Location")?.startsWith("https://example.test/login?"),
    );
  });

  it("rejects unknown grant_type with supported list", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: "cid",
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      error: string;
      error_description: string;
    };
    assert.equal(body.error, "unsupported_grant_type");
    assert.equal(body.error_description, "supported: authorization_code");
  });

  it("lists refresh_token in unsupported_grant_type when enabled", async () => {
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        refreshAccessToken: async () => ({
          accessToken: "t",
          expiresIn: 60,
        }),
      },
    });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: "cid",
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    const body = (await res.json()) as { error_description: string };
    assert.equal(
      body.error_description,
      "supported: authorization_code, refresh_token",
    );
  });

  it("rejects malformed token JSON with 400", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_request");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("omits CORS on token OPTIONS and wrong method", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const optionsRes = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", { method: "OPTIONS" }),
    );
    assert.ok(optionsRes);
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get("Access-Control-Allow-Origin"), null);

    const getRes = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", { method: "GET" }),
    );
    assert.ok(getRes);
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("filters disallowed redirect_uris on register", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example/cb", CLAUDE_CALLBACK],
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { redirect_uris: string[] };
    assert.deepEqual(body.redirect_uris, [CLAUDE_CALLBACK]);
  });

  it("rejects register when all redirect_uris are disallowed", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://evil.example/cb"],
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_redirect_uri");
  });
});

describe("tryHandle survives a throwing port", () => {
  it("returns server_error instead of rejecting when resolveUser throws", async () => {
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        resolveUser: async () => {
          throw new Error("IdP is unreachable");
        },
      },
    });
    const url = new URL("https://example.test/mcp/oauth/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "server_error");
  });

  it("returns server_error instead of rejecting when mintAccessToken throws", async () => {
    const verifier = "throwing-mint-verifier-abcdefghijklmnop";
    const challenge = await sha256Base64Url(verifier);

    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        mintAccessToken: async () => {
          throw new Error("token service is down");
        },
      },
    });

    const authUrl = new URL("https://example.test/mcp/oauth/authorize");
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const authorized = await router.tryHandle(
      new Request(authUrl, { method: "GET" }),
    );
    assert.ok(authorized);
    const code = new URL(authorized.headers.get("location")!).searchParams.get(
      "code",
    );
    assert.ok(code);

    const res = await router.tryHandle(
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: "c1",
          redirect_uri: CLAUDE_CALLBACK,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "server_error");
  });
});
