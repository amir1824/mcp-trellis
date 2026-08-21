import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OAUTH_BODY_LIMIT } from "../src/body.js";
import { stubPorts } from "./helpers/ports.js";
import { createOAuthRouter } from "./helpers/router.js";

const OVER_CAP = "x".repeat(DEFAULT_OAUTH_BODY_LIMIT + 1);

const claim = async (
  router: ReturnType<typeof createOAuthRouter>,
  request: Request,
): Promise<Response> => {
  const res = await router.tryHandle(request);
  assert.ok(res, `router did not claim ${new URL(request.url).pathname}`);
  return res;
};

describe("OAuth endpoints reject an oversized body with 413", () => {
  const router = createOAuthRouter({
    ports: stubPorts({ revokeToken: async () => {} }),
    allowUnregisteredClients: true,
  });

  it("/token — honest oversized Content-Length is rejected before parsing", async () => {
    const res = await claim(
      router,
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(DEFAULT_OAUTH_BODY_LIMIT + 1),
        },
        body: OVER_CAP,
      }),
    );
    assert.equal(res.status, 413);
  });

  it("/revoke — honest oversized Content-Length is rejected before parsing", async () => {
    const res = await claim(
      router,
      new Request("https://example.test/mcp/oauth/revoke", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(DEFAULT_OAUTH_BODY_LIMIT + 1),
        },
        body: OVER_CAP,
      }),
    );
    assert.equal(res.status, 413);
  });

  it("/register — honest oversized Content-Length is rejected before parsing", async () => {
    const res = await claim(
      router,
      new Request("https://example.test/mcp/oauth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(DEFAULT_OAUTH_BODY_LIMIT + 1),
        },
        body: JSON.stringify({ redirect_uris: ["https://example.test/cb"] }),
      }),
    );
    assert.equal(res.status, 413);
  });

  it("/consent — honest oversized Content-Length is rejected before parsing", async () => {
    const res = await claim(
      router,
      new Request("https://example.test/mcp/oauth/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(DEFAULT_OAUTH_BODY_LIMIT + 1),
        },
        body: OVER_CAP,
      }),
    );
    assert.equal(res.status, 413);
  });

  it("/token accepts a well-formed body within the cap (sanity check for the above)", async () => {
    const res = await claim(
      router,
      new Request("https://example.test/mcp/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code" }).toString(),
      }),
    );
    // Rejected for a different reason (invalid_grant/no code) — the point is it's not 413.
    assert.notEqual(res.status, 413);
  });
});
