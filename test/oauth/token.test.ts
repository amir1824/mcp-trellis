import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url } from "../../src/oauth/pkce.js";
import { expectOAuthError, expectOAuthRedirectError } from "../helpers/http.js";
import {
  authorizeCode,
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  forgeCode,
  redeem,
} from "../helpers/oauth.js";
import { HARNESS_CODE_SECRET, recordingPorts } from "../helpers/ports.js";
import { createOAuthRouter } from "../helpers/router.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;

// Every mismatch test needs unregistered clients admitted so client-auth
// (`firstClientAuthError`) never short-circuits before the grant handler
// gets a chance to compare `record` against the presented body.
const makeRouter = () => {
  const { ports, mintCalls } = recordingPorts();
  const router = createOAuthRouter({ allowUnregisteredClients: true, ports });
  return { router, mintCalls };
};

describe("firstAuthCodeMismatch", () => {
  it("rejects a redirect_uri that differs from the one the code was minted for", async () => {
    const { router, mintCalls } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, {
      redirectUri: "http://127.0.0.1:9999/cb",
    });
    await expectOAuthError(res, 400, "invalid_grant");
    assert.deepEqual(mintCalls, []);
  });

  it("names the redirect_uri mismatch in error_description", async () => {
    const { router } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, {
      redirectUri: "http://127.0.0.1:9999/cb",
    });
    const body = (await res.json()) as { error_description: string };
    assert.equal(body.error_description, "redirect_uri mismatch");
  });

  it("rejects a client_id that differs from the one the code was minted for", async () => {
    const { router, mintCalls } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, { clientId: "other-client" });
    const body = (await res.json()) as { error: string; error_description: string };
    assert.equal(res.status, 400);
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.error_description, "client_id mismatch");
    assert.deepEqual(mintCalls, []);
  });

  it("checks redirect_uri before client_id", async () => {
    const { router } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, {
      redirectUri: "http://127.0.0.1:9999/cb",
      clientId: "other-client",
    });
    const body = (await res.json()) as { error_description: string };
    assert.equal(body.error_description, "redirect_uri mismatch");
  });
});

describe("PKCE verification at /token", () => {
  it("rejects the wrong verifier", async () => {
    const { router, mintCalls } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, { codeVerifier: "wrong-verifier" });
    await expectOAuthError(res, 400, "invalid_grant");
    assert.deepEqual(mintCalls, []);
  });

  it("rejects an omitted verifier (distinct from an empty one)", async () => {
    const { router } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, { codeVerifier: null });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("rejects an empty-string verifier", async () => {
    const { router } = makeRouter();
    const session = await authorizeCode(router);
    const res = await redeem(router, session, { codeVerifier: "" });
    await expectOAuthError(res, 400, "invalid_grant");
  });

  it("redirects challenge_method=plain at authorize (S256 is mandatory) — RFC 6749 §4.1.2.1", async () => {
    const { router } = makeRouter();
    const verifier = "plain-verifier-value-long-enough";
    const res = await router.tryHandle(
      new Request(
        `${ORIGIN}/mcp/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: DEFAULT_CLIENT_ID,
          redirect_uri: DEFAULT_REDIRECT_URI,
          code_challenge: verifier,
          code_challenge_method: "plain",
          resource: RESOURCE,
        }).toString()}`,
      ),
    );
    assert.ok(res);
    expectOAuthRedirectError(res, "invalid_request");
  });

  it("redirects a missing code_challenge at authorize", async () => {
    const { router } = makeRouter();
    const res = await router.tryHandle(
      new Request(
        `${ORIGIN}/mcp/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: DEFAULT_CLIENT_ID,
          redirect_uri: DEFAULT_REDIRECT_URI,
          code_challenge_method: "S256",
          resource: RESOURCE,
        }).toString()}`,
      ),
    );
    assert.ok(res);
    expectOAuthRedirectError(res, "invalid_request");
  });
});

describe("code replay", () => {
  it("rejects redeeming the same code twice", async () => {
    const { router } = makeRouter();
    const session = await authorizeCode(router);
    const first = await redeem(router, session);
    assert.equal(first.status, 200);
    const second = await redeem(router, session);
    await expectOAuthError(second, 400, "invalid_grant");
  });
});

describe("forged expiry", () => {
  it("rejects a code that was already expired the moment it was minted", async () => {
    const { router, mintCalls } = makeRouter();
    const verifier = "forged-expiry-verifier-value-long-enough";
    const challenge = await sha256Base64Url(verifier);
    const code = await forgeCode(HARNESS_CODE_SECRET, {
      clientId: DEFAULT_CLIENT_ID,
      redirectUri: DEFAULT_REDIRECT_URI,
      codeChallenge: challenge,
      userId: "harness-user",
      resource: RESOURCE,
      scope: "mcp",
    });
    const res = await redeem(router, {
      code,
      verifier,
      clientId: DEFAULT_CLIENT_ID,
      redirectUri: DEFAULT_REDIRECT_URI,
      resource: RESOURCE,
    });
    await expectOAuthError(res, 400, "invalid_grant");
    assert.deepEqual(mintCalls, []);
  });
});
