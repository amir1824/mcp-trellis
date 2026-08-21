import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_CALLBACK } from "../../src/oauth/redirect.js";
import { expectOAuthError, expectOAuthRedirectError } from "../helpers/http.js";
import { stubPorts } from "../helpers/ports.js";
import { createOAuthRouter } from "../helpers/router.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:4321/cb";

const authorizeUrl = (overrides: Record<string, string | undefined> = {}): URL => {
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: "c1",
    redirect_uri: REDIRECT_URI,
    code_challenge: "challenge-value",
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, value);
  }
  return url;
};

const router = () => createOAuthRouter({ ports: stubPorts() });

describe("authorize error delivery — RFC 6749 §4.1.2.1", () => {
  describe("pre-trust tier: redirect_uri is not yet trusted, so these stay direct JSON", () => {
    it("an unallowed redirect_uri never becomes a redirect target", async () => {
      const res = await router().tryHandle(
        new Request(authorizeUrl({ redirect_uri: "https://not-on-any-allowlist.test/cb" })),
      );
      assert.ok(res);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
      await expectOAuthError(res, 400, "invalid_request");
    });

    it("a missing redirect_uri never becomes a redirect target", async () => {
      const res = await router().tryHandle(new Request(authorizeUrl({ redirect_uri: "" })));
      assert.ok(res);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });

    it("an oversized state is rejected directly, not reflected into a redirect", async () => {
      const res = await router().tryHandle(new Request(authorizeUrl({ state: "x".repeat(2049) })));
      assert.ok(res);
      assert.equal(res.status, 400);
      assert.equal(res.headers.get("location"), null);
    });
  });

  describe("post-trust tier: redirect_uri is trusted, so every remaining error redirects to it", () => {
    it("response_type !== code → unsupported_response_type, redirected", async () => {
      const res = await router().tryHandle(
        new Request(authorizeUrl({ response_type: "token", state: "s1" })),
      );
      assert.ok(res);
      const location = expectOAuthRedirectError(res, "unsupported_response_type", "s1");
      assert.equal(new URL(location.origin + location.pathname).toString(), `${REDIRECT_URI}`);
    });

    it("code_challenge_method=plain → invalid_request, redirected", async () => {
      const res = await router().tryHandle(
        new Request(authorizeUrl({ code_challenge_method: "plain" })),
      );
      assert.ok(res);
      expectOAuthRedirectError(res, "invalid_request");
    });

    it("missing code_challenge → invalid_request, redirected", async () => {
      const res = await router().tryHandle(new Request(authorizeUrl({ code_challenge: "" })));
      assert.ok(res);
      expectOAuthRedirectError(res, "invalid_request");
    });

    it("missing resource → invalid_request, redirected, with error_description", async () => {
      const res = await router().tryHandle(new Request(authorizeUrl({ resource: "" })));
      assert.ok(res);
      const location = expectOAuthRedirectError(res, "invalid_request");
      assert.equal(location.searchParams.get("error_description"), "resource required (RFC 8707)");
    });

    it("wrong resource → invalid_target, redirected", async () => {
      const res = await router().tryHandle(
        new Request(authorizeUrl({ resource: "https://evil.test/mcp" })),
      );
      assert.ok(res);
      expectOAuthRedirectError(res, "invalid_target");
    });

    it("preserves state across a redirected error, and omits it when absent", async () => {
      const withState = await router().tryHandle(
        new Request(authorizeUrl({ response_type: "token", state: "round-trip-me" })),
      );
      assert.ok(withState);
      expectOAuthRedirectError(withState, "unsupported_response_type", "round-trip-me");

      const withoutState = await router().tryHandle(
        new Request(authorizeUrl({ response_type: "token" })),
      );
      assert.ok(withoutState);
      const location = expectOAuthRedirectError(withoutState, "unsupported_response_type");
      assert.equal(location.searchParams.has("state"), false);
    });
  });
});

const unauthenticatedAuthorize = (loginUrl: (req: Request, next: string) => string) => {
  const router = createOAuthRouter({
    ports: stubPorts({ resolveUser: async () => null, loginUrl }),
  });
  const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: "c1",
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: "challenge",
    code_challenge_method: "S256",
    resource: RESOURCE,
  }).toString();
  return router.tryHandle(new Request(url, { method: "GET" }));
};

// src/oauth/authorize.ts:126-138 — a host's `loginUrl` is arbitrary code;
// this guard is what stands between a broken/malicious `loginUrl` and an
// open redirect or a redirect to a non-HTTP scheme.
describe("loginUrl guard", () => {
  it("500s when loginUrl returns a javascript: URL", async () => {
    const res = await unauthenticatedAuthorize(() => "javascript:alert(1)");
    assert.ok(res);
    await expectOAuthError(res, 500, "invalid_request");
  });

  it("500s when loginUrl returns an unparsable string", async () => {
    const res = await unauthenticatedAuthorize(() => "http://[::1");
    assert.ok(res);
    await expectOAuthError(res, 500, "invalid_request");
  });

  it("500s when loginUrl returns a data: URL", async () => {
    const res = await unauthenticatedAuthorize(() => "data:text/html,hi");
    assert.ok(res);
    await expectOAuthError(res, 500, "invalid_request");
  });

  it("302s to the same origin when loginUrl returns a relative path, preserving next", async () => {
    const res = await unauthenticatedAuthorize(
      (_req, next) => `/login?next=${encodeURIComponent(next)}`,
    );
    assert.ok(res);
    assert.equal(res.status, 302);
    const locationHeader = res.headers.get("location");
    assert.ok(locationHeader);
    const location = new URL(locationHeader);
    assert.equal(location.origin, ORIGIN);
    assert.equal(location.pathname, "/login");
    assert.ok(location.searchParams.get("next")?.includes("/mcp/oauth/authorize"));
  });

  it("302s when loginUrl returns an absolute http(s) URL", async () => {
    const res = await unauthenticatedAuthorize(() => "https://idp.example/login");
    assert.ok(res);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://idp.example/login");
  });
});
