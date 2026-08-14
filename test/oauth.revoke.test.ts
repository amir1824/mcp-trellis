import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOAuthRouter } from "../src/oauth/router.js";
import type { ClientStore, RevokeTokenInput } from "../src/oauth/types.js";

const ORIGIN = "https://example.test";

const basePorts = {
  codeSecret: "secret",
  resolveUser: async () => ({ id: "u1" }),
  loginUrl: () => `${ORIGIN}/login`,
  mintAccessToken: async () => ({
    accessToken: "tok",
    expiresIn: 3600,
  }),
};

const revokePost = (
  router: ReturnType<typeof createOAuthRouter>,
  body: string,
) =>
  router.tryHandle(
    new Request(`${ORIGIN}/mcp/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
  );

describe("token revocation (RFC 7009)", () => {
  it("unmounts /revoke and omits it from metadata when the port is absent", async () => {
    const router = createOAuthRouter({ ports: basePorts });
    const route = await revokePost(router, "token=abc&client_id=c1");
    assert.equal(route, null);

    const metaRes = await router.tryHandle(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    assert.ok(metaRes);
    const meta = (await metaRes.json()) as {
      revocation_endpoint?: string;
    };
    assert.equal(meta.revocation_endpoint, undefined);
  });

  it("advertises revocation_endpoint when the port is set", async () => {
    const router = createOAuthRouter({
      ports: { ...basePorts, revokeToken: async () => undefined },
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    assert.ok(res);
    const meta = (await res.json()) as {
      revocation_endpoint: string;
      revocation_endpoint_auth_methods_supported: string[];
    };
    assert.equal(meta.revocation_endpoint, `${ORIGIN}/mcp/oauth/revoke`);
    assert.deepEqual(meta.revocation_endpoint_auth_methods_supported, ["none"]);
  });

  it("calls the port and returns 200 empty on a well-formed form POST", async () => {
    const seen: RevokeTokenInput[] = [];
    const router = createOAuthRouter({
      ports: {
        ...basePorts,
        revokeToken: async (input) => {
          seen.push(input);
        },
      },
    });
    const res = await revokePost(
      router,
      "token=stolen&client_id=c1&token_type_hint=access_token",
    );
    assert.ok(res);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
    assert.deepEqual(seen, [
      {
        token: "stolen",
        clientId: "c1",
        tokenTypeHint: "access_token",
      },
    ]);
  });

  it("omits CORS on revoke OPTIONS, GET, and POST", async () => {
    const router = createOAuthRouter({
      ports: { ...basePorts, revokeToken: async () => undefined },
    });
    const optionsRes = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/revoke`, { method: "OPTIONS" }),
    );
    assert.ok(optionsRes);
    assert.equal(optionsRes.status, 204);
    assert.equal(optionsRes.headers.get("Access-Control-Allow-Origin"), null);

    const getRes = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/revoke`, { method: "GET" }),
    );
    assert.ok(getRes);
    assert.equal(getRes.status, 405);
    assert.equal(getRes.headers.get("Access-Control-Allow-Origin"), null);

    const postRes = await revokePost(router, "token=stolen&client_id=c1");
    assert.ok(postRes);
    assert.equal(postRes.status, 200);
    assert.equal(postRes.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("rejects a missing token with invalid_request", async () => {
    const router = createOAuthRouter({
      ports: { ...basePorts, revokeToken: async () => undefined },
    });
    const res = await revokePost(router, "client_id=c1");
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_request",
    );
  });

  it("rejects an unregistered client_id when locked down", async () => {
    const clientStore: ClientStore = {
      get: async () => null,
    };
    const router = createOAuthRouter({
      allowUnregisteredClients: false,
      ports: {
        ...basePorts,
        clientStore,
        revokeToken: async () => undefined,
      },
    });
    const res = await revokePost(
      router,
      "token=stolen&client_id=self-issued",
    );
    assert.ok(res);
    assert.equal(res.status, 401);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_client",
    );
  });
});
