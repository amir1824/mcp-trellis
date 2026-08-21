import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstScopeError, formatScope, parseScope, requestedScopes } from "../src/oauth/scope.js";
import { expectOAuthRedirectError } from "./helpers/http.js";
import { accessToken } from "./helpers/oauth.js";
import { recordingPorts } from "./helpers/ports.js";
import { createOAuthRouter } from "./helpers/router.js";

describe("parseScope / formatScope", () => {
  it("splits on spaces and trims empty entries", () => {
    assert.deepEqual(parseScope("mcp  read "), ["mcp", "read"]);
    assert.deepEqual(parseScope(""), []);
    assert.deepEqual(parseScope("   "), []);
  });

  it("formatScope joins with a single space", () => {
    assert.equal(formatScope(["mcp", "read"]), "mcp read");
    assert.equal(formatScope([]), "");
  });
});

describe("requestedScopes", () => {
  const advertised = ["mcp", "read", "write"];

  it("falls back to the full advertised set when scope is omitted", () => {
    assert.deepEqual(requestedScopes("", advertised), advertised);
  });

  it("parses and dedupes an explicit scope string", () => {
    assert.deepEqual(requestedScopes("read read mcp", advertised), ["read", "mcp"]);
  });
});

describe("firstScopeError", () => {
  const advertised = ["mcp", "read"];

  it("passes a fully-advertised request", () => {
    assert.equal(firstScopeError(["mcp"], advertised), null);
  });

  it("rejects a scope outside the advertised set", async () => {
    const res = firstScopeError(["mcp", "admin"], advertised);
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; error_description: string };
    assert.equal(body.error, "invalid_scope");
    assert.equal(body.error_description, "unsupported scope: admin");
  });
});

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;

describe("invalid_scope at the HTTP level", () => {
  it("redirects the raw /authorize request with invalid_scope (RFC 6749 §4.1.2.1) and never mints a token", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({ scopes: ["mcp", "read"], defaultScopes: ["mcp"], ports });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: "c1",
      redirect_uri: "http://127.0.0.1:4321/cb",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "mcp admin",
      state: "s1",
    }).toString();
    const res = await router.tryHandle(new Request(url, { method: "GET" }));
    assert.ok(res);
    const location = expectOAuthRedirectError(res, "invalid_scope", "s1");
    assert.equal(location.searchParams.get("error_description"), "unsupported scope: admin");
    assert.deepEqual(mintCalls, []);
  });
});

describe("scope narrowing reaches mintAccessToken", () => {
  it("passes the narrowed, deduped grant to mintAccessToken — not the raw request scope", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({
      scopes: ["mcp", "read", "write"],
      defaultScopes: ["mcp"],
      ports,
    });
    await accessToken(router, { scope: "read read mcp" });
    assert.equal(mintCalls.length, 1);
    assert.equal(mintCalls[0]?.scope, "read mcp");
  });

  it("grants exactly defaultScopes — not the full advertised set — when the client omits scope", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({
      scopes: ["mcp", "read", "write"],
      defaultScopes: ["mcp"],
      ports,
    });
    await accessToken(router, { scope: null });
    assert.equal(mintCalls[0]?.scope, "mcp");
  });

  it("a single advertised scope still defaults to the full (single-entry) set with no defaultScopes", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({ scopes: ["mcp"], ports });
    await accessToken(router, { scope: null });
    assert.equal(mintCalls[0]?.scope, "mcp");
  });
});

describe("least-privilege scope construction guard", () => {
  it("throws at construction when scopes has more than one entry and defaultScopes is omitted", () => {
    const { ports } = recordingPorts();
    assert.throws(
      () => createOAuthRouter({ scopes: ["mcp", "read"], ports }),
      /defaultScopes must say what an omitted scope request grants/,
    );
  });

  it("does not throw for a single advertised scope, defaultScopes omitted", () => {
    const { ports } = recordingPorts();
    assert.doesNotThrow(() => createOAuthRouter({ scopes: ["mcp"], ports }));
  });

  it("throws when defaultScopes names a scope outside the advertised set", () => {
    const { ports } = recordingPorts();
    assert.throws(
      () => createOAuthRouter({ scopes: ["mcp", "read"], defaultScopes: ["admin"], ports }),
      /defaultScopes contains "admin", which is not in scopes/,
    );
  });

  it("defaultScopes: [] is a valid least-privilege choice — omitted scope grants nothing", async () => {
    const { ports, mintCalls } = recordingPorts();
    const router = createOAuthRouter({ scopes: ["mcp", "read"], defaultScopes: [], ports });
    await accessToken(router, { scope: null });
    assert.equal(mintCalls[0]?.scope, "");
  });
});
