/**
 * requireRegisteredClients + CIMD: URL-shaped client_id must be re-resolved,
 * never accepted by shape alone at /token.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;
const CLIENT_ID = "https://clients.example/claude.json";
const SECRET = "cimd-auth-test-code-secret-value-32ch!";

const doc = {
  client_id: CLIENT_ID,
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none" as const,
};

describe("CIMD + requireRegisteredClients at /token", () => {
  it("rejects a URL-shaped client_id when cimd is off (default)", async () => {
    const router = createOAuthRouter({
      requireRegisteredClients: true,
      ports: stubPorts({
        codeSecret: SECRET,
        refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 60 }),
      }),
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt",
          client_id: CLIENT_ID,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
  });

  it("accepts a URL-shaped client_id only after a successful CIMD resolve", async () => {
    let resolves = 0;
    const router = createOAuthRouter({
      requireRegisteredClients: true,
      cimd: true,
      cimdCache: {
        get: async () => {
          resolves += 1;
          return doc;
        },
        set: async () => undefined,
      },
      ports: stubPorts({
        codeSecret: SECRET,
        refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 60, scope: "mcp" }),
      }),
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt",
          client_id: CLIENT_ID,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(resolves, 1);
  });

  it("rejects URL-shaped client_id when CIMD resolve fails", async () => {
    const events: string[] = [];
    const router = createOAuthRouter({
      requireRegisteredClients: true,
      cimd: true,
      cimdCache: {
        get: async () => null,
        set: async () => undefined,
      },
      cimdLookup: async () => ["10.0.0.1"],
      ports: stubPorts({
        codeSecret: SECRET,
        refreshAccessToken: async () => ({ accessToken: "a", expiresIn: 60 }),
        audit: (entry) => {
          events.push(entry.event);
        },
      }),
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt",
          client_id: CLIENT_ID,
          resource: RESOURCE,
        }).toString(),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_client");
    assert.deepEqual(events, ["cimd_resolve_failed", "client_auth_failed"]);
  });
});
