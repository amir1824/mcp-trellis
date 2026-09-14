/**
 * Dual-handler auth-code single-use — two routers sharing one CodeStore
 * (the multi-instance shape). Redeeming the same code twice must fail on
 * the second handler; that is the property production deploys need.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryCodeStore } from "../../src/oauth/codes.js";
import { sha256Base64Url } from "../../src/oauth/pkce.js";
import { stubPorts } from "../helpers/ports.js";
import { createOAuthRouter } from "../helpers/router.js";
import { DEFAULT_ORIGIN } from "../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const SECRET = "replay-e2e-code-secret-value-32chars!!";

const CONSENT_TICKET_RE = /name="consent_ticket"\s+value="([^"]+)"/;

const issueCode = async (
  router: ReturnType<typeof createOAuthRouter>,
): Promise<{ code: string; challenge: string }> => {
  const verifier = "replay-verifier-value-long-enough-for-pkce";
  const challenge = await sha256Base64Url(verifier);
  const authorizeUrl = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: "replay-client",
    redirect_uri: "http://127.0.0.1:31337/cb",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();

  const consentPage = await router.tryHandle(new Request(authorizeUrl, { method: "GET" }));
  assert.ok(consentPage);
  assert.equal(consentPage.status, 200);
  const ticket = (await consentPage.text()).match(CONSENT_TICKET_RE)?.[1];
  assert.ok(ticket);

  const approved = await router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        consent_ticket: ticket,
        approved: "true",
      }).toString(),
    }),
  );
  assert.ok(approved);
  assert.equal(approved.status, 302);
  const location = approved.headers.get("Location");
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);
  return { code, challenge: verifier };
};

const redeem = (
  router: ReturnType<typeof createOAuthRouter>,
  code: string,
  verifier: string,
): Promise<Response | null> =>
  router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://127.0.0.1:31337/cb",
        client_id: "replay-client",
        code_verifier: verifier,
        resource: RESOURCE,
      }).toString(),
    }),
  );

describe("shared codeStore single-use across two handlers", () => {
  it("rejects a second redeem on a sibling router sharing the same CodeStore", async () => {
    const codeStore = createMemoryCodeStore();
    const ports = stubPorts({ codeSecret: SECRET, codeStore });
    const routerA = createOAuthRouter({
      allowUnregisteredClients: true,
      requireRegisteredClients: false,
      ports,
    });
    const routerB = createOAuthRouter({
      allowUnregisteredClients: true,
      requireRegisteredClients: false,
      ports,
    });

    const { code, challenge: verifier } = await issueCode(routerA);
    const first = await redeem(routerA, code, verifier);
    assert.ok(first);
    assert.equal(first.status, 200);

    const second = await redeem(routerB, code, verifier);
    assert.ok(second);
    assert.equal(second.status, 400);
    const body = (await second.json()) as { error: string };
    assert.equal(body.error, "invalid_grant");
  });

  it("refuses to construct without codeStore unless allowInMemoryCodeStore is set", async () => {
    const { createOAuthRouter: create } = await import("../../src/oauth/router.js");
    assert.throws(
      () =>
        create({
          requireRegisteredClients: false,
          ports: stubPorts({ codeSecret: SECRET }),
        }),
      /codeStore is required/,
    );
    assert.doesNotThrow(() =>
      create({
        requireRegisteredClients: false,
        allowInMemoryCodeStore: true,
        ports: stubPorts({ codeSecret: SECRET }),
      }),
    );
  });
});
