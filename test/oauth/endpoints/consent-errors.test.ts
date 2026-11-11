import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptsHtml } from "../../../src/oauth/endpoints/consent/error-page.js";
import { VALID_S256_CHALLENGE } from "../../helpers/oauth.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const REDIRECT = "http://127.0.0.1:31337/callback";
const TICKET_RE = /name="consent_ticket"\s+value="([^"]+)"/;
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

type Session = { id: string } | null;

const setup = () => {
  const state: { user: Session } = { user: { id: "alice" } };
  const router = createOAuthRouter({
    allowUnregisteredClients: true,
    ports: stubPorts({ resolveUser: async () => state.user }),
  });
  return { router, state };
};

const getTicket = async (router: ReturnType<typeof createOAuthRouter>): Promise<string> => {
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "some-client",
    redirect_uri: REDIRECT,
    code_challenge: VALID_S256_CHALLENGE,
    code_challenge_method: "S256",
    resource: `${ORIGIN}/mcp`,
  }).toString();
  const page = await router.tryHandle(new Request(url));
  assert.ok(page);
  const match = (await page.text()).match(TICKET_RE);
  assert.ok(match?.[1]);
  return match[1];
};

const postConsent = async (
  router: ReturnType<typeof createOAuthRouter>,
  ticket: string,
  accept?: string,
): Promise<Response> => {
  const res = await router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/consent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(accept === undefined ? {} : { Accept: accept }),
      },
      body: new URLSearchParams({ consent_ticket: ticket, approved: "true" }).toString(),
    }),
  );
  assert.ok(res);
  return res;
};

describe("consent failures for a browser (Accept: text/html)", () => {
  it("shows a readable page, still 400, for a ticket that is not valid", async () => {
    const { router } = setup();
    const res = await postConsent(router, "not-a-ticket", BROWSER_ACCEPT);
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /This approval request expired/);
  });

  it("shows the session page when the app session ended before Approve", async () => {
    const { router, state } = setup();
    const ticket = await getTicket(router);
    state.user = null;
    const res = await postConsent(router, ticket, BROWSER_ACCEPT);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Your sign-in changed or expired/);
  });

  it("shows the same page for a different user as for no session, so it is no oracle", async () => {
    const { router, state } = setup();
    const ticket = await getTicket(router);
    state.user = { id: "bob" };
    const asOtherUser = await (await postConsent(router, ticket, BROWSER_ACCEPT)).text();
    state.user = null;
    const asNobody = await (await postConsent(router, ticket, BROWSER_ACCEPT)).text();
    assert.equal(asOtherUser, asNobody);
  });

  it("shows the already-submitted page on a second Approve", async () => {
    const { router } = setup();
    const ticket = await getTicket(router);
    const first = await postConsent(router, ticket, BROWSER_ACCEPT);
    assert.equal(first.status, 302);
    const second = await postConsent(router, ticket, BROWSER_ACCEPT);
    assert.equal(second.status, 400);
    assert.match(await second.text(), /already submitted/);
  });

  it("treats a store answer that is not exactly true as already submitted", async () => {
    const router = createOAuthRouter({
      allowUnregisteredClients: true,
      ports: stubPorts({
        resolveUser: async () => ({ id: "alice" }),
        codeStore: { consume: () => "yes" as unknown as boolean },
      }),
    });
    const ticket = await getTicket(router);
    const res = await postConsent(router, ticket, BROWSER_ACCEPT);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /already submitted/);
  });

  it("carries nothing from the request or the ticket", async () => {
    const { router, state } = setup();
    const ticket = await getTicket(router);
    state.user = null;
    const html = await (await postConsent(router, ticket, BROWSER_ACCEPT)).text();
    assert.ok(!html.includes(ticket));
    assert.ok(!html.includes("127.0.0.1"));
    assert.doesNotMatch(html, /<script|<form|<a |<img|<iframe/i);
    const hostile = await (
      await postConsent(router, "<script>alert(1)</script>", BROWSER_ACCEPT)
    ).text();
    assert.doesNotMatch(hostile, /alert/);
  });

  it("is locked down: no form, no base, no framing, no caching, no sniffing", async () => {
    const { router } = setup();
    const res = await postConsent(router, "x", BROWSER_ACCEPT);
    const csp = res.headers.get("content-security-policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });
});

describe("consent failures for every other caller keep the JSON error", () => {
  it("keeps the JSON error for a caller that does not ask for HTML", async () => {
    const { router, state } = setup();
    const ticket = await getTicket(router);
    state.user = null;
    const body = (await (await postConsent(router, ticket)).json()) as {
      error_description: string;
    };
    assert.equal(body.error_description, "consent_ticket does not match the current user");
  });
});

describe("acceptsHtml", () => {
  it("accepts only an explicit text/html range with q above zero", () => {
    assert.equal(acceptsHtml("text/html"), true);
    assert.equal(acceptsHtml("TEXT/HTML; charset=utf-8"), true);
    assert.equal(acceptsHtml(BROWSER_ACCEPT), true);
    assert.equal(acceptsHtml("application/json, text/html;q=0.1"), true);
  });

  it("refuses everything else", () => {
    assert.equal(acceptsHtml(null), false);
    assert.equal(acceptsHtml(""), false);
    assert.equal(acceptsHtml("*/*"), false);
    assert.equal(acceptsHtml("text/*"), false);
    assert.equal(acceptsHtml("text/html;q=0"), false);
    assert.equal(acceptsHtml("text/html;q=abc"), false);
    assert.equal(acceptsHtml("application/json"), false);
  });
});
