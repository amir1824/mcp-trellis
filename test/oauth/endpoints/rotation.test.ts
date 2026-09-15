/**
 * End-to-end `codeSecret` rotation: sealed material issued by one router
 * instance (configured with an old secret) must keep verifying against a
 * second instance configured with `[newSecret, oldSecret]`, and every such
 * verification must audit `legacy_code_secret_used` so an operator knows
 * when it's safe to drop the old key.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url } from "../../../src/oauth/crypto/pkce.js";
import type { OAuthAuditEntry } from "../../../src/oauth/types.js";
import { expectOAuthError } from "../../helpers/http.js";
import { memoryClientStore, stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const OLD_SECRET = "rotation-old-code-secret-value-32-chars!";
const NEW_SECRET = "rotation-new-code-secret-value-32-chars!";
const REDIRECT = "http://127.0.0.1:9333/cb";

const CONSENT_TICKET_RE = /name="consent_ticket"\s+value="([^"]+)"/;

describe("codeSecret rotation", () => {
  it("a DCR client_id sealed under the old key still authorizes once rotated to [new, old]", async () => {
    const routerA = createOAuthRouter({ ports: stubPorts({ codeSecret: OLD_SECRET }) });
    const registerRes = await routerA.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      }),
    );
    assert.ok(registerRes);
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

    const entries: OAuthAuditEntry[] = [];
    const routerB = createOAuthRouter({
      ports: stubPorts({
        codeSecret: [NEW_SECRET, OLD_SECRET],
        audit: (e) => void entries.push(e),
      }),
    });
    const challenge = await sha256Base64Url("rotation-dcr-verifier-value-long-enough!");
    const authUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();

    const res = await routerB.tryHandle(new Request(authUrl, { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 200, "the old-sealed client_id must still bind and reach consent");

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.event, "legacy_code_secret_used");
    assert.match(entries[0]?.reason ?? "", /client assertion unsealed with codeSecret\[1\]/);
  });

  it("an auth code sealed under the old key redeems at /token once rotated, auditing legacy usage", async () => {
    const clientStore = memoryClientStore([
      { clientId: "trusted-client", redirectUris: [REDIRECT], tokenEndpointAuthMethod: "none" },
    ]);
    const routerA = createOAuthRouter({
      ports: stubPorts({ codeSecret: OLD_SECRET, clientStore }),
      consent: { preApprovedClientIds: ["trusted-client"] },
    });
    const verifier = "rotation-code-verifier-value-long-enough!!";
    const challenge = await sha256Base64Url(verifier);
    const authUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "trusted-client",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const authRes = await routerA.tryHandle(new Request(authUrl, { method: "GET" }));
    assert.ok(authRes);
    assert.equal(authRes.status, 302);
    const code = new URL(authRes.headers.get("Location") ?? "").searchParams.get("code");
    assert.ok(code);

    const entries: OAuthAuditEntry[] = [];
    const routerB = createOAuthRouter({
      ports: stubPorts({
        codeSecret: [NEW_SECRET, OLD_SECRET],
        clientStore,
        audit: (e) => void entries.push(e),
      }),
      consent: { preApprovedClientIds: ["trusted-client"] },
    });
    const tokenRes = await routerB.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: "trusted-client",
          redirect_uri: REDIRECT,
          code_verifier: verifier,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(tokenRes);
    assert.equal(tokenRes.status, 200, "the old-sealed code must still redeem for an access token");

    const legacy = entries.filter((e) => e.event === "legacy_code_secret_used");
    assert.equal(legacy.length, 1);
    assert.match(legacy[0]?.reason ?? "", /auth code redeemed with codeSecret\[1\]/);
  });

  it("a consent ticket sealed under the old key redeems once rotated, auditing legacy usage", async () => {
    const routerA = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({ codeSecret: OLD_SECRET }),
    });
    const challenge = await sha256Base64Url("rotation-consent-verifier-value-long-enough");
    const authUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: "attacker-or-unregistered-client",
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const authRes = await routerA.tryHandle(new Request(authUrl, { method: "GET" }));
    assert.ok(authRes);
    assert.equal(authRes.status, 200);
    const ticket = (await authRes.text()).match(CONSENT_TICKET_RE)?.[1];
    assert.ok(ticket);

    const entries: OAuthAuditEntry[] = [];
    const routerB = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({
        codeSecret: [NEW_SECRET, OLD_SECRET],
        audit: (e) => void entries.push(e),
      }),
    });
    const consentRes = await routerB.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }).toString(),
      }),
    );
    assert.ok(consentRes);
    assert.equal(consentRes.status, 302, "the old-sealed ticket must still redeem for a code");

    const legacy = entries.filter((e) => e.event === "legacy_code_secret_used");
    assert.equal(legacy.length, 1);
    assert.match(legacy[0]?.reason ?? "", /consent ticket unsealed with codeSecret\[1\]/);
  });

  it("new material is always sealed with the primary (first) key — unrecoverable once that key alone is dropped", async () => {
    const routerB = createOAuthRouter({
      ports: stubPorts({ codeSecret: [NEW_SECRET, OLD_SECRET] }),
    });
    const registerRes = await routerB.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: [REDIRECT] }),
      }),
    );
    assert.ok(registerRes);
    const { client_id: clientId } = (await registerRes.json()) as { client_id: string };

    // Only the OLD key remains configured — the primary (NEW) key that
    // actually sealed this client_id is gone. requireRegisteredClients
    // (true here) is what makes an unresolved client_id actually rejected
    // instead of silently falling back to an unbound public client.
    const routerOldOnly = createOAuthRouter({
      requireRegisteredClients: true,
      ports: stubPorts({ codeSecret: OLD_SECRET }),
    });
    const challenge = await sha256Base64Url("rotation-orphaned-verifier-value-long-enough");
    const authUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const res = await routerOldOnly.tryHandle(new Request(authUrl, { method: "GET" }));
    assert.ok(res);
    await expectOAuthError(res, 400, "unauthorized_client");
  });

  it("throws at construction on an empty codeSecret array", () => {
    assert.throws(
      () => createOAuthRouter({ ports: stubPorts({ codeSecret: [] }) }),
      /codeSecret array must not be empty/,
    );
  });

  it("throws at construction if any entry in a codeSecret array is too short", () => {
    assert.throws(
      () => createOAuthRouter({ ports: stubPorts({ codeSecret: [NEW_SECRET, "too-short"] }) }),
      /codeSecret must be at least/,
    );
  });

  it("a function-form codeSecret may resolve to an array per request", async () => {
    const router = createOAuthRouter({
      ports: stubPorts({ codeSecret: async () => [NEW_SECRET, OLD_SECRET] }),
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    assert.ok(res);
    assert.equal(res.status, 200, "a valid array from a function form must not 500");
  });
});
