import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AccessDeniedError } from "../../../src/oauth/errors.js";
import type { OAuthAuditEntry, OAuthPorts } from "../../../src/oauth/types.js";
import { expectOAuthError } from "../../helpers/http.js";
import { authorizeCode, DEFAULT_CLIENT_ID, redeem } from "../../helpers/oauth.js";
import {
  HARNESS_CODE_SECRET,
  recordingPorts,
  type StubPortsOverrides,
} from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const REASON = "user alice is not a member of tenant globex";

const makeRouter = (overrides: StubPortsOverrides) => {
  const audits: OAuthAuditEntry[] = [];
  const { ports } = recordingPorts({ ...overrides, audit: (entry) => void audits.push(entry) });
  const router = createOAuthRouter({ allowUnregisteredClients: true, ports });
  return { router, audits };
};

const refresh = (router: ReturnType<typeof makeRouter>["router"]) =>
  router.tryHandle(
    new Request(`${DEFAULT_ORIGIN}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: "rt",
        client_id: DEFAULT_CLIENT_ID,
        resource: `${DEFAULT_ORIGIN}/mcp`,
      }),
    }),
  );

describe("a port that refuses a grant on purpose", () => {
  it("answers a denied authorization-code mint with 400 invalid_grant", async () => {
    const { router } = makeRouter({
      mintAccessToken: async () => {
        throw new AccessDeniedError(REASON);
      },
    });
    const res = await redeem(router, await authorizeCode(router));
    await expectOAuthError(res.clone(), 400, "invalid_grant");
    const body = (await res.json()) as { error_description: string };
    assert.equal(body.error_description, "access denied");
  });

  it("keeps the reason out of the response and in the audit log", async () => {
    const { router, audits } = makeRouter({
      mintAccessToken: async () => {
        throw new AccessDeniedError(REASON);
      },
    });
    const res = await redeem(router, await authorizeCode(router));
    const text = await res.text();
    assert.equal(text.includes(REASON), false);
    assert.deepEqual(audits, [
      { event: "access_denied", clientId: DEFAULT_CLIENT_ID, reason: REASON },
    ]);
  });

  it("answers a denied refresh with 400 invalid_grant", async () => {
    const { router, audits } = makeRouter({
      refreshAccessToken: async () => {
        throw new AccessDeniedError(REASON);
      },
    });
    const res = await refresh(router);
    assert.ok(res);
    await expectOAuthError(res, 400, "invalid_grant");
    assert.deepEqual(audits, [
      { event: "access_denied", clientId: DEFAULT_CLIENT_ID, reason: REASON },
    ]);
  });

  it("still answers an unexpected port failure with 500 server_error", async () => {
    const { router } = makeRouter({
      mintAccessToken: async () => {
        throw new Error("database is down");
      },
    });
    const res = await redeem(router, await authorizeCode(router));
    await expectOAuthError(res, 500, "server_error");
  });

  it("still answers an unexpected refresh failure with 500 server_error", async () => {
    const { router } = makeRouter({
      refreshAccessToken: async () => {
        throw new Error("database is down");
      },
    });
    const res = await refresh(router);
    assert.ok(res);
    await expectOAuthError(res, 500, "server_error");
  });
});

describe("the refresh port", () => {
  it("is called as a method of the ports object, so a port that reads `this` works", async () => {
    let seenSecret: unknown;
    const { router } = makeRouter({
      async refreshAccessToken(this: OAuthPorts) {
        seenSecret = this.codeSecret;
        return { accessToken: "a", expiresIn: 60 };
      },
    });
    const res = await refresh(router);
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(seenSecret, HARNESS_CODE_SECRET);
  });
});
