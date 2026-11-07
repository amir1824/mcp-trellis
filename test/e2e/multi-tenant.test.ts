import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createMultiTenantApp, listRows } from "../../examples/multi-tenant.js";

const callback = "http://127.0.0.1:4000/cb";
const verifier = "a-valid-pkce-verifier-with-more-than-forty-three-characters";
const challenge = createHash("sha256").update(verifier).digest("base64url");
const required = <T>(value: T | null | undefined): T => {
  assert.ok(value != null);
  return value;
};
const app = createMultiTenantApp({
  codeSecret: "local-test-code-secret-with-at-least-32-chars",
  accessSecret: "local-test-access-secret-with-at-least-32-chars",
});

const register = async (origin: string): Promise<string> => {
  const registered = await app.fetch(
    new Request(`${origin}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [callback] }),
    }),
  );
  return ((await registered.json()) as { client_id: string }).client_id;
};

/** Log in as `user` on `origin`, approve consent, and return the /token response. */
const connect = async (host: string, user: string): Promise<Response> => {
  const origin = `https://${host}`;
  const clientId = await register(origin);
  const auth = new URL(`${origin}/mcp/oauth/authorize`);
  auth.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callback,
    resource: `${origin}/mcp`,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: "s",
  }).toString();
  const asUser = { "x-demo-user": user };
  const consent = await app.fetch(new Request(auth, { headers: asUser }));
  const ticket = required(
    (await consent.text()).match(/name="consent_ticket"\s+value="([^"]+)"/)?.[1],
  );
  const approved = await app.fetch(
    new Request(`${origin}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, ...asUser },
      body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }),
    }),
  );
  const code = required(
    new URL(required(approved.headers.get("location"))).searchParams.get("code"),
  );
  return app.fetch(
    new Request(`${origin}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: callback,
        resource: `${origin}/mcp`,
        code_verifier: verifier,
      }),
    }),
  );
};

const listRowsWith = async (host: string, token: string): Promise<string> => {
  const response = await app.fetch(
    new Request(`https://${host}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_rows", arguments: {} },
      }),
    }),
  );
  const body = (await response.json()) as { result: { content: { text: string }[] } };
  return required(body.result.content[0]).text;
};

describe("multi-tenant example: membership decides who gets a token", () => {
  it("issues a token to a member and lists only that tenant's rows", async () => {
    const response = await connect("acme.mcp.example.com", "alice");
    assert.equal(response.status, 200);
    const { access_token } = (await response.json()) as { access_token: string };
    assert.equal(
      await listRowsWith("acme.mcp.example.com", access_token),
      '["invoice-1","invoice-2"]',
    );
  });

  it("refuses a token for a tenant the user does not belong to", async () => {
    const response = await connect("globex.mcp.example.com", "alice");
    // `AccessDeniedError` from `mintAccessToken` is a deliberate refusal: 400
    // invalid_grant, not a 500, and no token is issued.
    assert.equal(response.status, 400);
    assert.equal(((await response.clone().json()) as { error: string }).error, "invalid_grant");
    assert.equal(((await response.json()) as { access_token?: string }).access_token, undefined);
  });
});

// Handler-level on purpose. Through `tools/call` the guard is unreachable from
// this example: a token minted for another tenant's origin is rejected by the
// audience check before any tool runs, and a non-member never gets a token. The
// check stays as defense in depth for a token that outlives a membership change.
describe("multi-tenant example: the tool checks membership on every call", () => {
  it("rejects a caller who is not a member of the request's tenant", async () => {
    await assert.rejects(
      async () => listRows.handler({ userId: "alice", tenantId: "globex" }, {}),
      /not a member/,
    );
  });
});
