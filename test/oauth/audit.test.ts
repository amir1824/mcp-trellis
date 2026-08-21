import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url } from "../../src/oauth/pkce.js";
import type { ClientStore, OAuthAuditEntry } from "../../src/oauth/types.js";
import { createOAuthRouter } from "../helpers/router.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const CODE_SECRET = "audit-test-code-secret-value-32-characters";

const basePorts = {
  codeSecret: CODE_SECRET,
  resolveUser: async () => ({ id: "u1" }),
  loginUrl: () => `${ORIGIN}/login`,
  mintAccessToken: async () => ({ accessToken: "tok", expiresIn: 3600 }),
};

const tokenRequest = (body: Record<string, string>, auth?: string) =>
  new Request(`${ORIGIN}/mcp/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: new URLSearchParams(body).toString(),
  });

describe("OAuth audit hook — client_auth_failed", () => {
  const gemini: ClientStore = {
    get: async (clientId) =>
      clientId === "gemini-client"
        ? { clientId, redirectUris: [], tokenEndpointAuthMethod: "client_secret_basic" }
        : null,
    verifySecret: async (_id, presented) => presented === "the-real-secret",
  };

  it("audits the real reason for an unknown client_id on a locked-down server, not just invalid_client", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      allowUnregisteredClients: false,
      ports: { ...basePorts, clientStore: gemini, audit: (e) => void entries.push(e) },
    });
    const res = await router.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "someone-else" }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "client_auth_failed");
    assert.equal(entries[0]?.reason, "unknown client_id");
  });

  it("audits an auth-method mismatch by its real reason", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: { ...basePorts, clientStore: gemini, audit: (e) => void entries.push(e) },
    });
    const res = await router.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "gemini-client" }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(entries[0]?.reason, "client requires client_secret_basic, got none");
  });

  it("audits a missing secret distinctly from a wrong one", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: { ...basePorts, clientStore: gemini, audit: (e) => void entries.push(e) },
    });
    const emptyPassword = Buffer.from("gemini-client:").toString("base64");
    await router.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x" }, `Basic ${emptyPassword}`),
    );
    assert.equal(entries[0]?.reason, "client_secret required");
  });

  it("audits a wrong verifySecret result distinctly from a missing verifySecret port", async () => {
    const wrongSecretEntries: OAuthAuditEntry[] = [];
    const wrongSecretRouter = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: { ...basePorts, clientStore: gemini, audit: (e) => void wrongSecretEntries.push(e) },
    });
    const wrong = Buffer.from("gemini-client:not-the-secret").toString("base64");
    await wrongSecretRouter.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x" }, `Basic ${wrong}`),
    );
    assert.equal(wrongSecretEntries[0]?.reason, "verifySecret returned false");

    const noVerifyEntries: OAuthAuditEntry[] = [];
    const noVerifyStore: ClientStore = { get: gemini.get };
    const noVerifyRouter = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: {
        ...basePorts,
        clientStore: noVerifyStore,
        audit: (e) => void noVerifyEntries.push(e),
      },
    });
    const anySecret = Buffer.from("gemini-client:anything").toString("base64");
    await noVerifyRouter.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x" }, `Basic ${anySecret}`),
    );
    assert.equal(noVerifyEntries[0]?.reason, "clientStore.verifySecret is not configured");
  });

  it("audits secretHash null (no hash on file) distinctly from a hash mismatch", async () => {
    const store: ClientStore = {
      get: gemini.get,
      secretHash: async (clientId) =>
        clientId === "has-hash" ? "hmac-sha256$doesnotmatter" : null,
    };

    const noHashEntries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      tokenEndpointAuthMethods: ["client_secret_basic"],
      ports: { ...basePorts, clientStore: store, audit: (e) => void noHashEntries.push(e) },
    });
    const basic = Buffer.from("gemini-client:whatever").toString("base64");
    await router.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x" }, `Basic ${basic}`),
    );
    assert.equal(noHashEntries[0]?.reason, "no secretHash on file for this client");
  });

  it("a throwing OAuth audit port never fails the request", async () => {
    const router = createOAuthRouter({
      allowUnregisteredClients: false,
      ports: {
        ...basePorts,
        clientStore: gemini,
        audit: () => {
          throw new Error("telemetry sink down");
        },
      },
    });
    const res = await router.tryHandle(
      tokenRequest({ grant_type: "authorization_code", code: "x", client_id: "someone-else" }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
  });
});

describe("OAuth audit hook — server_error (rejected codeSecret, host port exceptions)", () => {
  it("audits the real codeSecret rejection reason while the caller sees only server_error", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        codeSecret: () => "too-short", // fails assertCodeSecret's 32-char minimum
        audit: (e) => void entries.push(e),
      },
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough-here"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as { error: string }).error, "server_error");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "server_error");
    assert.match(entries[0]?.reason ?? "", /codeSecret must be at least 32 characters/);
  });

  it("audits a throwing host port (e.g. resolveUser) by its real message", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        resolveUser: async () => {
          throw new Error("upstream identity provider unreachable");
        },
        audit: (e) => void entries.push(e),
      },
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: await sha256Base64Url("verifier-value-long-enough-here"),
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 500);
    assert.equal(entries[0]?.event, "server_error");
    assert.equal(entries[0]?.reason, "upstream identity provider unreachable");
  });
});
