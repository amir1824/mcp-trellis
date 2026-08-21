import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url } from "../src/oauth/pkce.js";
import { expectOAuthError } from "./helpers/http.js";
import { stubPorts } from "./helpers/ports.js";
import { createOAuthRouter } from "./helpers/router.js";
import { DEFAULT_ORIGIN } from "./helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_A = "http://127.0.0.1:9111/cb";
const REDIRECT_B = "http://127.0.0.1:9222/cb";

const register = async (
  router: ReturnType<typeof createOAuthRouter>,
  redirectUris: string[],
): Promise<string> => {
  const res = await router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: redirectUris }),
    }),
  );
  assert.ok(res);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
  assert.deepEqual(body.redirect_uris, redirectUris);
  return body.client_id;
};

const CONSENT_TICKET_RE = /name="consent_ticket"\s+value="([^"]+)"/;

const authorizeAndApprove = async (
  router: ReturnType<typeof createOAuthRouter>,
  overrides: { clientId: string; redirectUri: string; challenge: string },
): Promise<Response> => {
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: overrides.clientId,
    redirect_uri: overrides.redirectUri,
    code_challenge: overrides.challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  const res = await router.tryHandle(new Request(url, { method: "GET" }));
  assert.ok(res);
  return res;
};

describe("DCR client_id binding", () => {
  it("issues a client_id that is not a plain random string but a self-verifying assertion", async () => {
    const router = createOAuthRouter({ ports: stubPorts() });
    const clientId = await register(router, [REDIRECT_A]);
    assert.ok(clientId.includes("."), "sealed client_id carries an iv.ciphertext shape");
  });

  it("binds the issued client_id to exactly the redirect_uris it registered — same as a stored registration", async () => {
    const router = createOAuthRouter({ ports: stubPorts() });
    const clientId = await register(router, [REDIRECT_A]);
    const challenge = await sha256Base64Url("dcr-verifier-value-long-enough-for-pkce");

    const ok = await authorizeAndApprove(router, { clientId, redirectUri: REDIRECT_A, challenge });
    assert.equal(ok.status, 200, "authorize must render the consent interstitial");

    const wrong = await authorizeAndApprove(router, {
      clientId,
      redirectUri: REDIRECT_B,
      challenge,
    });
    await expectOAuthError(wrong, 400, "invalid_request");
  });

  it("completes a full authorize → consent → token walk with a DCR-issued client_id", async () => {
    const router = createOAuthRouter({ ports: stubPorts() });
    const clientId = await register(router, [REDIRECT_A]);
    const verifier = "dcr-full-walk-verifier-value-long-enough";
    const challenge = await sha256Base64Url(verifier);

    const authorized = await authorizeAndApprove(router, {
      clientId,
      redirectUri: REDIRECT_A,
      challenge,
    });
    const html = await authorized.text();
    const ticket = html.match(CONSENT_TICKET_RE)?.[1];
    assert.ok(ticket);

    const approved = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }).toString(),
      }),
    );
    assert.ok(approved);
    assert.equal(approved.status, 302);
    const location = approved.headers.get("Location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const tokenRes = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: REDIRECT_A,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(tokenRes);
    assert.equal(tokenRes.status, 200);
  });

  it("does not treat a self-invented, non-sealed id as bound — global allowlist still applies", async () => {
    const router = createOAuthRouter({ ports: stubPorts() });
    const challenge = await sha256Base64Url("free-form-verifier-value-long-enough");
    const res = await authorizeAndApprove(router, {
      clientId: "self-invented-client",
      redirectUri: "http://127.0.0.1:9333/cb",
      challenge,
    });
    // Not bound to any list, but loopback is on the default allowlist.
    assert.equal(res.status, 200);
  });

  it("a client_id sealed under a different codeSecret does not unseal — never treated as bound", async () => {
    const routerA = createOAuthRouter({
      ports: stubPorts({ codeSecret: "secret-a-value-32-characters-long!!" }),
    });
    const clientId = await register(routerA, [REDIRECT_A]);

    // A restrictive global allowlist on B: if the assertion leaked across
    // secrets, redirectAllowed would bind to A's list and this would
    // succeed on REDIRECT_A alone despite the empty allowlist below.
    const routerB = createOAuthRouter({
      ports: stubPorts({ codeSecret: "secret-b-value-32-characters-long!!" }),
      redirect: { allowLoopback: false, allowClaude: false, extra: [] },
    });
    const challenge = await sha256Base64Url("cross-secret-verifier-value-long-enough");
    const res = await authorizeAndApprove(routerB, {
      clientId,
      redirectUri: REDIRECT_A,
      challenge,
    });
    await expectOAuthError(res, 400, "invalid_request");
  });
});

describe("requireRegisteredClients", () => {
  it("rejects a self-invented client_id at /authorize even though allowUnregisteredClients is true", async () => {
    const router = createOAuthRouter({
      ports: stubPorts(),
      requireRegisteredClients: true,
    });
    const challenge = await sha256Base64Url("required-registration-verifier-value-long");
    const res = await authorizeAndApprove(router, {
      clientId: "self-invented-client",
      redirectUri: REDIRECT_A,
      challenge,
    });
    await expectOAuthError(res, 400, "unauthorized_client");
  });

  it("still accepts a DCR-issued sealed client_id — /register stays mounted", async () => {
    const router = createOAuthRouter({
      ports: stubPorts(),
      requireRegisteredClients: true,
    });
    const clientId = await register(router, [REDIRECT_A]);
    const challenge = await sha256Base64Url("required-registration-dcr-verifier-value");
    const res = await authorizeAndApprove(router, { clientId, redirectUri: REDIRECT_A, challenge });
    assert.equal(res.status, 200);
  });

  it("still accepts a clientStore pre-registered client_id", async () => {
    const router = createOAuthRouter({
      ports: stubPorts({
        clientStore: {
          get: async (clientId) =>
            clientId === "preregistered"
              ? {
                  clientId,
                  redirectUris: [REDIRECT_A],
                  tokenEndpointAuthMethod: "none",
                }
              : null,
        },
      }),
      requireRegisteredClients: true,
    });
    const challenge = await sha256Base64Url("required-registration-store-verifier-value");
    const res = await authorizeAndApprove(router, {
      clientId: "preregistered",
      redirectUri: REDIRECT_A,
      challenge,
    });
    assert.equal(res.status, 200);
  });
});
