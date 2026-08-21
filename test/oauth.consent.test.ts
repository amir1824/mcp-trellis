import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expectOAuthError } from "./helpers/http.js";
import { memoryClientStore, recordingPorts, stubPorts } from "./helpers/ports.js";
import { createOAuthRouter, type OAuthRouterOptions } from "./helpers/router.js";
import { DEFAULT_ORIGIN } from "./helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;

const CONSENT_TICKET_RE = /name="consent_ticket"\s+value="([^"]+)"/;

const extractTicket = (html: string): string => {
  const match = html.match(CONSENT_TICKET_RE);
  assert.ok(match?.[1], "consent page must carry a well-formed consent_ticket");
  return match[1];
};

const authorizeUrl = (overrides: Record<string, string> = {}): URL => {
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "attacker-client",
    redirect_uri: "http://127.0.0.1:31337/x",
    code_challenge: "any-challenge-string-here",
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  }).toString();
  return url;
};

const postConsent = (
  router: ReturnType<typeof createOAuthRouter>,
  body: Record<string, string>,
): Promise<Response | null> =>
  router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/consent`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  );

describe("consent — cross-site walk (acceptance criterion)", () => {
  it("renders a 200 interstitial for an attacker-controlled client, never a redirect or a code", async () => {
    const { ports } = recordingPorts();
    const router = createOAuthRouter({ allowUnregisteredClients: true, ports });

    const res = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null);

    const body = await res.text();
    assert.doesNotMatch(body, /[?&]code=/);
    assert.doesNotMatch(body, /"code"\s*:/);
  });

  it("issues no access token until the ticket is explicitly approved", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({ allowUnregisteredClients: true, ports });
    await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.deepEqual(mintCalls, []);
  });
});

describe("consent interstitial hardening", () => {
  const makeRouter = () =>
    createOAuthRouter({ allowUnregisteredClients: true, ports: stubPorts() });

  it("sends CSP, X-Frame-Options, Referrer-Policy, and Cache-Control", async () => {
    const router = makeRouter();
    const res = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(res);
    assert.match(res.headers.get("Content-Security-Policy") ?? "", /default-src 'none'/);
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  });

  it("HTML-escapes an attacker-controlled client_id — no raw markup reflected", async () => {
    const router = makeRouter();
    const res = await router.tryHandle(
      new Request(authorizeUrl({ client_id: "<img src=x onerror=alert(1)>" }), {
        method: "GET",
      }),
    );
    assert.ok(res);
    const body = await res.text();
    assert.doesNotMatch(body, /<img src=x onerror=alert\(1\)>/);
    assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it("HTML-escapes a redirect_uri carrying a quote, still passing the loopback predicate", async () => {
    const router = makeRouter();
    const redirectUri = 'http://127.0.0.1:31337/x?"><script>alert(1)</script>';
    const res = await router.tryHandle(
      new Request(authorizeUrl({ redirect_uri: redirectUri }), { method: "GET" }),
    );
    assert.ok(res);
    const body = await res.text();
    assert.doesNotMatch(body, /<script>alert\(1\)<\/script>/);
  });

  it("405s a GET to /consent — approval is POST only", async () => {
    const router = makeRouter();
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/consent`, { method: "GET" }),
    );
    assert.ok(res);
    assert.equal(res.status, 405);
  });
});

describe("consent ticket lifecycle", () => {
  const makeRouter = (overrides: Partial<OAuthRouterOptions> = {}) =>
    createOAuthRouter({ allowUnregisteredClients: true, ports: stubPorts(), ...overrides });

  const getTicket = async (router: ReturnType<typeof createOAuthRouter>): Promise<string> => {
    const res = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(res);
    return extractTicket(await res.text());
  };

  it("redeems an approved ticket for a code, redirecting to redirect_uri", async () => {
    const router = makeRouter();
    const ticket = await getTicket(router);
    const res = await postConsent(router, { consent_ticket: ticket, approved: "true" });
    assert.ok(res);
    assert.equal(res.status, 302);
    const location = res.headers.get("Location");
    assert.ok(location);
    const target = new URL(location);
    assert.equal(target.origin, "http://127.0.0.1:31337");
    assert.ok(target.searchParams.get("code"));
  });

  it("rejects replaying the same ticket a second time", async () => {
    const router = makeRouter();
    const ticket = await getTicket(router);
    const first = await postConsent(router, { consent_ticket: ticket, approved: "true" });
    assert.ok(first);
    assert.equal(first.status, 302);

    const second = await postConsent(router, { consent_ticket: ticket, approved: "true" });
    assert.ok(second);
    await expectOAuthError(second, 400, "invalid_grant");
  });

  it("rejects a ticket issued to a different user than the one now resolved", async () => {
    let currentUser = "alice";
    const router = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({ resolveUser: async () => ({ id: currentUser }) }),
    });
    const ticket = await getTicket(router);
    currentUser = "bob";
    const res = await postConsent(router, { consent_ticket: ticket, approved: "true" });
    assert.ok(res);
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("redirects to redirect_uri with error=access_denied on denial, preserving state", async () => {
    const router = makeRouter();
    const res = await router.tryHandle(
      new Request(authorizeUrl({ state: "xyz" }), { method: "GET" }),
    );
    assert.ok(res);
    const ticket = extractTicket(await res.text());
    const denied = await postConsent(router, { consent_ticket: ticket, approved: "false" });
    assert.ok(denied);
    assert.equal(denied.status, 302);
    const location = denied.headers.get("Location");
    assert.ok(location);
    const target = new URL(location);
    assert.equal(target.searchParams.get("error"), "access_denied");
    assert.equal(target.searchParams.get("state"), "xyz");
    assert.equal(target.searchParams.get("code"), null);
  });

  it("rejects a consent POST with no ticket", async () => {
    const router = makeRouter();
    const res = await postConsent(router, { approved: "true" });
    assert.ok(res);
    await expectOAuthError(res, 400, "invalid_request");
  });

  it("rejects a malformed/garbage ticket", async () => {
    const router = makeRouter();
    const res = await postConsent(router, {
      consent_ticket: "not-a-real-ticket",
      approved: "true",
    });
    assert.ok(res);
    await expectOAuthError(res, 400, "invalid_grant");
  });
});

describe("domain separation — a consent ticket is never redeemable as an auth code, and vice versa", () => {
  it("rejects presenting a consent ticket at /token as an authorization code", async () => {
    const router = createOAuthRouter({ allowUnregisteredClients: true, ports: stubPorts() });
    const authRes = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(authRes);
    const ticket = extractTicket(await authRes.text());

    const tokenRes = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: ticket,
          redirect_uri: "http://127.0.0.1:31337/x",
          client_id: "attacker-client",
          code_verifier: "irrelevant-but-long-enough-verifier",
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(tokenRes);
    await expectOAuthError(tokenRes, 400, "invalid_grant");
  });

  it("rejects presenting a redeemed authorization code as a consent_ticket", async () => {
    const router = createOAuthRouter({ allowUnregisteredClients: true, ports: stubPorts() });
    const authRes = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(authRes);
    const ticket = extractTicket(await authRes.text());
    const approved = await postConsent(router, { consent_ticket: ticket, approved: "true" });
    assert.ok(approved);
    const location = approved.headers.get("Location");
    assert.ok(location);
    const code = new URL(location).searchParams.get("code");
    assert.ok(code);

    const res = await postConsent(router, { consent_ticket: code, approved: "true" });
    assert.ok(res);
    await expectOAuthError(res, 400, "invalid_grant");
  });
});

describe("preApprovedClientIds", () => {
  it("skips the interstitial and redirects directly for a resolved, pre-approved client", async () => {
    const clientStore = memoryClientStore([
      {
        clientId: "trusted-client",
        redirectUris: ["https://trusted.test/cb"],
        tokenEndpointAuthMethod: "none",
      },
    ]);
    const { ports, mintCalls } = recordingPorts({ clientStore });
    const router = createOAuthRouter({
      ports,
      consent: { preApprovedClientIds: ["trusted-client"] },
    });
    const res = await router.tryHandle(
      new Request(
        authorizeUrl({ client_id: "trusted-client", redirect_uri: "https://trusted.test/cb" }),
        { method: "GET" },
      ),
    );
    assert.ok(res);
    assert.equal(res.status, 302);
    const location = res.headers.get("Location");
    assert.ok(location);
    assert.ok(new URL(location).searchParams.get("code"));
    assert.deepEqual(mintCalls, []);
  });

  it("still requires consent when the client_id is not resolved by clientStore, even if pre-approved", async () => {
    const clientStore = memoryClientStore([]);
    const router = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({ clientStore }),
      consent: { preApprovedClientIds: ["trusted-client"] },
    });
    const res = await router.tryHandle(
      new Request(
        authorizeUrl({ client_id: "trusted-client", redirect_uri: "http://127.0.0.1:31337/x" }),
        { method: "GET" },
      ),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Location"), null);
  });
});

describe("custom consent.render", () => {
  it("delegates rendering to the host-supplied callback with the validated request", async () => {
    let seen: { clientId: string; scope: string[] } | undefined;
    const router = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts(),
      consent: {
        render: (input) => {
          seen = { clientId: input.clientId, scope: input.scope };
          return new Response(JSON.stringify({ consent_ticket: input.ticket }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    });
    const res = await router.tryHandle(new Request(authorizeUrl(), { method: "GET" }));
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(seen?.clientId, "attacker-client");
    assert.deepEqual(seen?.scope, ["mcp"]);
    const { consent_ticket } = (await res.json()) as { consent_ticket: string };
    assert.ok(consent_ticket);
  });
});
