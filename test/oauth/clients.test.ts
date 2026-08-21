import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authMethodsFor,
  hasDynamicClient,
  preRegisteredClients,
  redirectUrisFor,
} from "../../src/clients.js";
import { sha256Base64Url } from "../../src/oauth/pkce.js";
import { CLAUDE_CALLBACK } from "../../src/oauth/redirect.js";
import { hashClientSecret } from "../../src/oauth/router.js";
import type { ClientStore } from "../../src/oauth/types.js";
import { createOAuthRouter } from "../helpers/router.js";

const ORIGIN = "https://app.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://gemini.test/callback";
const SECRET = "s3cr3t-value";

describe("client profiles", () => {
  it("composes redirect URIs from the named clients", () => {
    assert.deepEqual(redirectUrisFor(["claude"]), [CLAUDE_CALLBACK]);
    assert.deepEqual(redirectUrisFor(["gemini"]), []);
    assert.deepEqual(redirectUrisFor(["claude", "codex"]), [CLAUDE_CALLBACK]);
  });

  it("composes advertised auth methods in a stable order", () => {
    assert.deepEqual(authMethodsFor(["claude"]), ["none"]);
    assert.deepEqual(authMethodsFor(["gemini"]), ["client_secret_basic", "client_secret_post"]);
    assert.deepEqual(authMethodsFor(["claude", "gemini"]), [
      "none",
      "client_secret_basic",
      "client_secret_post",
    ]);
  });

  it("identifies which clients need a clientStore", () => {
    assert.deepEqual(preRegisteredClients(["claude", "codex"]), []);
    assert.deepEqual(preRegisteredClients(["claude", "gemini"]), ["gemini"]);
  });

  it("detects when a configured client registers dynamically", () => {
    assert.equal(hasDynamicClient(["claude"]), true);
    assert.equal(hasDynamicClient(["codex"]), true);
    assert.equal(hasDynamicClient(["claude", "gemini"]), true);
    assert.equal(hasDynamicClient(["gemini"]), false);
    assert.equal(hasDynamicClient([]), false);
  });
});

const authorizeForCode = async (
  router: ReturnType<typeof createOAuthRouter>,
  challenge: string,
): Promise<string> => {
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "gemini-client",
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();

  const res = await router.tryHandle(new Request(url, { method: "GET" }));
  assert.ok(res);
  assert.equal(res.status, 200, "authorize must render the consent interstitial");
  const html = await res.text();
  const ticketMatch = html.match(/name="consent_ticket"\s+value="([^"]+)"/);
  assert.ok(ticketMatch?.[1], "consent page must carry a well-formed consent_ticket");

  const approved = await router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        consent_ticket: ticketMatch[1],
        approved: "true",
      }).toString(),
    }),
  );
  assert.ok(approved);
  assert.equal(approved.status, 302);
  const location = approved.headers.get("location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return code;
};

describe("confidential clients", () => {
  const clientStore: ClientStore = {
    get: async (clientId) =>
      clientId === "gemini-client"
        ? {
            clientId,
            redirectUris: [REDIRECT],
            tokenEndpointAuthMethod: "client_secret_basic",
          }
        : null,
    verifySecret: async (_clientId, presented) => presented === SECRET,
  };

  const makeRouter = (authMethod: "client_secret_basic" | "client_secret_post") =>
    createOAuthRouter({
      tokenEndpointAuthMethods: [authMethod],
      ports: {
        codeSecret: "code-signing-secret-value-32-characters-long",
        resolveUser: async () => ({ id: "u1" }),
        loginUrl: () => `${ORIGIN}/login`,
        mintAccessToken: async ({ userId, scope }) => ({
          accessToken: `token-for-${userId}`,
          expiresIn: 3600,
          scope,
        }),
        clientStore: {
          ...clientStore,
          get: async (clientId) => {
            const found = await clientStore.get(clientId);
            return found ? { ...found, tokenEndpointAuthMethod: authMethod } : null;
          },
        },
      },
    });

  it("accepts client_secret_basic", async () => {
    const router = makeRouter("client_secret_basic");
    const verifier = "verifier-value-long-enough-for-pkce";
    const code = await authorizeForCode(router, await sha256Base64Url(verifier));

    const basic = Buffer.from(`gemini-client:${SECRET}`).toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string };
    assert.equal(body.access_token, "token-for-u1");
  });

  it("accepts client_secret_post", async () => {
    const router = makeRouter("client_secret_post");
    const verifier = "verifier-value-long-enough-for-pkce";
    const code = await authorizeForCode(router, await sha256Base64Url(verifier));

    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: "gemini-client",
          client_secret: SECRET,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
  });

  it("rejects a wrong secret with invalid_client", async () => {
    const router = makeRouter("client_secret_basic");
    const basic = Buffer.from("gemini-client:wrong").toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("binds a pre-registered client to its own redirect URIs", async () => {
    const router = makeRouter("client_secret_basic");
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "gemini-client",
      redirect_uri: "https://attacker.test/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 400);
  });

  it("rejects a confidential client presenting no auth at all (method downgrade to none)", async () => {
    const router = makeRouter("client_secret_basic");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          client_id: "gemini-client",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("rejects Basic auth carrying an empty password (secret present in method, empty in value)", async () => {
    const router = makeRouter("client_secret_basic");
    const basic = Buffer.from("gemini-client:").toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
  });

  it("rejects a registered confidential client whose store configures neither verifySecret nor secretHash", async () => {
    const router = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: {
        codeSecret: "code-signing-secret-value-32-characters-long",
        resolveUser: async () => ({ id: "u1" }),
        loginUrl: () => `${ORIGIN}/login`,
        mintAccessToken: async () => ({ accessToken: "t", expiresIn: 60 }),
        clientStore: {
          get: async (clientId) =>
            clientId === "gemini-client"
              ? {
                  clientId,
                  redirectUris: [REDIRECT],
                  tokenEndpointAuthMethod: "client_secret_basic",
                }
              : null,
          // Neither verifySecret nor secretHash configured.
        },
      },
    });
    const basic = Buffer.from(`gemini-client:${SECRET}`).toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });
});

describe("client_secret_basic via secretHash (preferred over verifySecret)", () => {
  const CODE_SECRET = "code-signing-secret-value-32-characters-long";

  const makeHashRouter = (storedHash: string | null, alsoConfigureVerifySecret = false) =>
    createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: {
        codeSecret: CODE_SECRET,
        resolveUser: async () => ({ id: "u1" }),
        loginUrl: () => `${ORIGIN}/login`,
        mintAccessToken: async ({ userId, scope }) => ({
          accessToken: `token-for-${userId}`,
          expiresIn: 3600,
          scope,
        }),
        clientStore: {
          get: async (clientId) =>
            clientId === "gemini-client"
              ? {
                  clientId,
                  redirectUris: [REDIRECT],
                  tokenEndpointAuthMethod: "client_secret_basic",
                }
              : null,
          secretHash: async (clientId) => (clientId === "gemini-client" ? storedHash : null),
          // Present but must never be reached when secretHash is configured —
          // if this fires the "wrong secret" case below would pass for the
          // wrong reason.
          ...(alsoConfigureVerifySecret
            ? {
                verifySecret: async () =>
                  assert.fail("verifySecret must not be called when secretHash is set"),
              }
            : {}),
        },
      },
    });

  it("authenticates via a hash from hashClientSecret, preferred over verifySecret", async () => {
    const stored = await hashClientSecret(SECRET, CODE_SECRET);
    const router = makeHashRouter(stored, true);

    const verifier = "verifier-value-long-enough-for-pkce";
    const authorizeUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "gemini-client",
      redirect_uri: REDIRECT,
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const authRes = await router.tryHandle(new Request(authorizeUrl, { method: "GET" }));
    const html = await authRes?.text();
    const ticket = html?.match(/name="consent_ticket"\s+value="([^"]+)"/)?.[1];
    assert.ok(ticket);
    const consented = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }).toString(),
      }),
    );
    const code = new URL(consented?.headers.get("location") ?? "").searchParams.get("code");
    assert.ok(code);

    const basic = Buffer.from(`gemini-client:${SECRET}`).toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
  });

  it("rejects a wrong secret via secretHash with the same generic invalid_client", async () => {
    const stored = await hashClientSecret(SECRET, CODE_SECRET);
    const router = makeHashRouter(stored);

    const basic = Buffer.from("gemini-client:wrong-secret").toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("rejects when secretHash returns null (no hash on file) for an otherwise-known client", async () => {
    const router = makeHashRouter(null);
    const basic = Buffer.from(`gemini-client:${SECRET}`).toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "irrelevant",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
  });
});

describe("locked to pre-registered clients (allowUnregisteredClients: false)", () => {
  it("refuses to construct without a clientStore", () => {
    assert.throws(
      () =>
        createOAuthRouter({
          allowUnregisteredClients: false,
          ports: {
            codeSecret: "s",
            resolveUser: async () => null,
            loginUrl: () => "/login",
            mintAccessToken: async () => ({
              accessToken: "t",
              expiresIn: 60,
            }),
          },
        }),
      /clientStore/,
    );
  });

  const clientStore: ClientStore = {
    get: async (clientId) =>
      clientId === "gemini-client"
        ? {
            clientId,
            redirectUris: [REDIRECT],
            tokenEndpointAuthMethod: "client_secret_basic",
          }
        : null,
    verifySecret: async (_clientId, presented) => presented === SECRET,
  };

  const router = createOAuthRouter({
    allowUnregisteredClients: false,
    tokenEndpointAuthMethods: ["client_secret_basic"],
    ports: {
      codeSecret: "code-signing-secret-value-32-characters-long",
      resolveUser: async () => ({ id: "u1" }),
      loginUrl: () => `${ORIGIN}/login`,
      mintAccessToken: async ({ userId, scope }) => ({
        accessToken: `token-for-${userId}`,
        expiresIn: 3600,
        scope,
      }),
      refreshAccessToken: async ({ refreshToken, clientId }) =>
        refreshToken === "rt-ok" && clientId === "gemini-client"
          ? { accessToken: "refreshed", expiresIn: 3600 }
          : null,
      clientStore,
    },
  });

  it("unmounts DCR — /register is not an OAuth route", async () => {
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    assert.equal(res, null);
  });

  it("drops registration_endpoint from AS metadata", async () => {
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    assert.ok(res);
    const meta = (await res.json()) as { registration_endpoint?: string };
    assert.equal(meta.registration_endpoint, undefined);
  });

  it("rejects an unregistered client_id at authorize, even via loopback", async () => {
    // The attacker never called /register — they just invented a client_id
    // and pointed at a loopback redirect, which the allowlist alone permits.
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "self-issued-client",
      redirect_uri: "http://127.0.0.1:4000/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "unauthorized_client");
  });

  it("rejects an unregistered client_id at token before grant dispatch", async () => {
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: "irrelevant",
          client_id: "self-issued-client",
          redirect_uri: "http://127.0.0.1:4000/cb",
          code_verifier: "whatever",
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("rejects redeeming a registered client's auth code as an unregistered client", async () => {
    const verifier = "verifier-value-long-enough-for-pkce";
    const code = await authorizeForCode(router, await sha256Base64Url(verifier));
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: "self-issued-client",
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("rejects an unregistered client_id on refresh_token", async () => {
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "rt-ok",
          client_id: "self-issued-client",
          resource: RESOURCE,
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("still serves the registered gemini client end to end", async () => {
    const verifier = "verifier-value-long-enough-for-pkce";
    const code = await authorizeForCode(router, await sha256Base64Url(verifier));

    const basic = Buffer.from(`gemini-client:${SECRET}`).toString("base64");
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basic}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
  });
});
