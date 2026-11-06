import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signPayload } from "../../src/auth/signed-payload.js";
import { type SignedTokenAuthOptions, signedTokenAuth } from "../../src/auth/signed-token.js";
import { type CodeStore, createMemoryCodeStore } from "../../src/oauth/crypto/codes.js";
import type { MintedToken } from "../../src/oauth/types.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";

const RESOURCE = "https://example.test/mcp";
const OLD_SECRET = "an-older-rotation-secret-32-characters-long";
const GRANT = { userId: "alice", clientId: "c1", scope: "mcp read", resource: RESOURCE };
const REQUEST = new Request(RESOURCE);

/** A real memory store that also records every jti it was asked to burn. */
const recordingStore = (): CodeStore & { burned: string[] } => {
  const inner = createMemoryCodeStore();
  const burned: string[] = [];
  return {
    burned,
    consume: (jti, expMs) => {
      burned.push(jti);
      return inner.consume(jti, expMs);
    },
  };
};

const build = (overrides: Partial<SignedTokenAuthOptions> = {}) => {
  const store = recordingStore();
  const auth = signedTokenAuth({
    secret: HARNESS_CODE_SECRET,
    resolveUser: async () => ({ id: "alice" }),
    loginUrl: () => "/login",
    codeStore: store,
    isUserActive: () => true,
    refreshTtlSeconds: 600,
    ...overrides,
  });
  const { refreshAccessToken, revokeToken } = auth;
  assert.ok(refreshAccessToken && revokeToken);
  return { auth, store, refresh: refreshAccessToken, revoke: revokeToken };
};

const initial = async (auth: ReturnType<typeof build>["auth"]): Promise<MintedToken> => {
  const minted = await auth.mintAccessToken(GRANT);
  assert.ok(minted.refreshToken);
  return minted;
};

const refreshInput = (
  refreshToken: string,
  extra: { clientId?: string; resource?: string; scope?: string } = {},
) => ({
  refreshToken,
  clientId: extra.clientId ?? "c1",
  resource: extra.resource ?? RESOURCE,
  ...(extra.scope === undefined ? {} : { scope: extra.scope }),
});

const payloadOf = (token: string): { exp: number; jti: string; scopes: string[] } =>
  JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString());

describe("signedTokenAuth refresh — configuration", () => {
  it("is off unless refreshTtlSeconds is set", async () => {
    const auth = signedTokenAuth({
      secret: HARNESS_CODE_SECRET,
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    assert.equal(auth.refreshAccessToken, undefined);
    assert.equal(auth.revokeToken, undefined);
    assert.equal((await auth.mintAccessToken(GRANT)).refreshToken, undefined);
  });

  it("refuses to start without an explicit codeStore", () => {
    assert.throws(() => build({ codeStore: undefined as never }), /explicit codeStore/);
  });

  it("refuses to start without isUserActive", () => {
    assert.throws(() => build({ isUserActive: undefined as never }), /isUserActive/);
  });

  it("refuses a ttl that is not a finite number above zero", () => {
    assert.throws(() => build({ refreshTtlSeconds: 0 }), /refreshTtlSeconds/);
    assert.throws(() => build({ refreshTtlSeconds: Number.NaN }), /refreshTtlSeconds/);
  });
});

describe("signedTokenAuth refresh — rotation", () => {
  it("returns a new access token and a different refresh token, with the original scope", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    const next = await refresh(refreshInput(first.refreshToken as string));
    assert.ok(next?.refreshToken);
    assert.notEqual(next.refreshToken, first.refreshToken);
    assert.equal(next.scope, "mcp read");
    const verified = await auth.verifyToken(next.accessToken, REQUEST);
    assert.deepEqual(verified, { userId: "alice", scopes: ["mcp", "read"], audience: RESOURCE });
  });

  it("accepts each refresh token once", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    assert.ok(await refresh(refreshInput(first.refreshToken as string)));
    assert.equal(await refresh(refreshInput(first.refreshToken as string)), null);
  });

  it("lets exactly one of two concurrent refreshes win", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    const results = await Promise.all([
      refresh(refreshInput(first.refreshToken as string)),
      refresh(refreshInput(first.refreshToken as string)),
    ]);
    assert.equal(results.filter((result) => result !== null).length, 1);
  });

  it("keeps the expiry fixed at consent, so rotation never extends a grant", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    const next = await refresh(refreshInput(first.refreshToken as string));
    assert.equal(
      payloadOf(next?.refreshToken as string).exp,
      payloadOf(first.refreshToken as string).exp,
    );
  });

  it("rejects a refresh token past its expiry", async () => {
    const { auth, refresh } = build({ refreshTtlSeconds: 0.01 });
    const first = await initial(auth);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await refresh(refreshInput(first.refreshToken as string)), null);
  });
});

describe("signedTokenAuth refresh — binding", () => {
  it("refuses another client and leaves the token usable by its owner", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    assert.equal(
      await refresh(refreshInput(first.refreshToken as string, { clientId: "thief" })),
      null,
    );
    assert.ok(await refresh(refreshInput(first.refreshToken as string)));
  });

  it("refuses another resource and leaves the token usable for its own", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    const elsewhere = refreshInput(first.refreshToken as string, {
      resource: "https://example.test/other",
    });
    assert.equal(await refresh(elsewhere), null);
    assert.ok(await refresh(refreshInput(first.refreshToken as string)));
  });

  it("refuses a scope the grant never held, including the wildcard", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    assert.equal(
      await refresh(refreshInput(first.refreshToken as string, { scope: "mcp admin" })),
      null,
    );
    assert.equal(await refresh(refreshInput(first.refreshToken as string, { scope: "*" })), null);
  });

  it("narrows to a subset, and the successor still holds the full grant", async () => {
    const { auth, refresh } = build();
    const first = await initial(auth);
    const narrowed = await refresh(refreshInput(first.refreshToken as string, { scope: "read" }));
    assert.equal(narrowed?.scope, "read");
    assert.deepEqual(payloadOf(narrowed?.refreshToken as string).scopes, ["mcp", "read"]);
  });

  it("does not burn a token that failed a binding check", async () => {
    const { auth, refresh, store } = build();
    const first = await initial(auth);
    await refresh(refreshInput(first.refreshToken as string, { clientId: "thief" }));
    await refresh(refreshInput(first.refreshToken as string, { scope: "admin" }));
    assert.deepEqual(store.burned, []);
  });
});

describe("signedTokenAuth refresh — user status", () => {
  it("refuses a refresh for a user who is no longer active, and does not burn the token", async () => {
    const active = { value: true };
    const { auth, refresh, store } = build({ isUserActive: () => active.value });
    const first = await initial(auth);
    active.value = false;
    assert.equal(await refresh(refreshInput(first.refreshToken as string)), null);
    assert.deepEqual(store.burned, []);
  });

  it("treats anything but true as inactive", async () => {
    const { auth, refresh } = build({ isUserActive: (() => "yes") as never });
    const first = await initial(auth);
    assert.equal(await refresh(refreshInput(first.refreshToken as string)), null);
  });

  it("rejects, never mints, when the user lookup throws", async () => {
    const { auth, refresh } = build({
      isUserActive: () => {
        throw new Error("db down");
      },
    });
    const first = await initial(auth);
    await assert.rejects(refresh(refreshInput(first.refreshToken as string)), /db down/);
  });

  it("rejects, never mints, when the store fails", async () => {
    const failing: CodeStore = {
      consume: () => {
        throw new Error("kv down");
      },
    };
    const { auth, refresh } = build({ codeStore: failing });
    const first = await initial(auth);
    await assert.rejects(refresh(refreshInput(first.refreshToken as string)), /kv down/);
  });

  it("does not call the lookup for garbage, on either token path", async () => {
    const calls: string[] = [];
    const { auth, refresh } = build({
      isUserActive: (userId) => {
        calls.push(userId);
        return true;
      },
    });
    await auth.verifyToken("garbage.garbage", REQUEST);
    await refresh(refreshInput("garbage.garbage"));
    assert.deepEqual(calls, []);
  });
});

describe("signedTokenAuth refresh — token kinds are not interchangeable", () => {
  it("rejects a refresh token presented as an access token", async () => {
    const { auth } = build();
    const first = await initial(auth);
    assert.equal(await auth.verifyToken(first.refreshToken as string, REQUEST), null);
  });

  it("rejects an access token presented to refresh and to revoke, without touching the store", async () => {
    const { auth, refresh, revoke, store } = build();
    const first = await initial(auth);
    assert.equal(await refresh(refreshInput(first.accessToken)), null);
    await revoke({ token: first.accessToken, clientId: "c1" });
    assert.deepEqual(store.burned, []);
  });

  it("rejects a refresh-shaped payload signed as an access token", async () => {
    const { refresh } = build();
    const forged = await signPayload(HARNESS_CODE_SECRET, "access", {
      userId: "alice",
      scopes: ["mcp"],
      audience: RESOURCE,
      clientId: "c1",
      exp: Date.now() + 60_000,
      jti: "x",
    });
    assert.equal(await refresh(refreshInput(forged)), null);
  });

  it("rejects an oversized token before doing any work", async () => {
    const { refresh, store } = build();
    assert.equal(await refresh(refreshInput(`${"a".repeat(5000)}.${"b".repeat(50)}`)), null);
    assert.deepEqual(store.burned, []);
  });
});

describe("signedTokenAuth revoke", () => {
  it("burns the refresh token so it can no longer be used", async () => {
    const { auth, refresh, revoke } = build();
    const first = await initial(auth);
    await revoke({ token: first.refreshToken as string, clientId: "c1" });
    assert.equal(await refresh(refreshInput(first.refreshToken as string)), null);
  });

  it("is a silent no-op for another client, garbage, and an unknown token", async () => {
    const { auth, refresh, revoke, store } = build();
    const first = await initial(auth);
    await revoke({ token: first.refreshToken as string, clientId: "thief" });
    await revoke({ token: "garbage", clientId: "c1" });
    assert.deepEqual(store.burned, []);
    assert.ok(await refresh(refreshInput(first.refreshToken as string)));
  });

  it("surfaces a store failure instead of reporting a logout that did not happen", async () => {
    const failing: CodeStore = {
      consume: () => {
        throw new Error("kv down");
      },
    };
    const { auth, revoke } = build({ codeStore: failing });
    const first = await initial(auth);
    await assert.rejects(
      revoke({ token: first.refreshToken as string, clientId: "c1" }),
      /kv down/,
    );
  });
});

describe("signedTokenAuth secret rotation", () => {
  it("verifies a token signed under the secret that is now second in the list", async () => {
    const before = signedTokenAuth({
      secret: OLD_SECRET,
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    const token = (await before.mintAccessToken(GRANT)).accessToken;
    const after = signedTokenAuth({
      secret: [HARNESS_CODE_SECRET, OLD_SECRET],
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    assert.equal((await after.verifyToken(token, REQUEST))?.userId, "alice");
  });

  it("signs with the first secret only, and refuses a token from a removed secret", async () => {
    const rotated = signedTokenAuth({
      secret: [HARNESS_CODE_SECRET, OLD_SECRET],
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    const newToken = (await rotated.mintAccessToken(GRANT)).accessToken;
    const removed = signedTokenAuth({
      secret: OLD_SECRET,
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    assert.equal(await removed.verifyToken(newToken, REQUEST), null);
    const oldToken = (await removed.mintAccessToken(GRANT)).accessToken;
    const onlyNew = signedTokenAuth({
      secret: HARNESS_CODE_SECRET,
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    assert.equal(await onlyNew.verifyToken(oldToken, REQUEST), null);
  });

  it("forwards the whole list as codeSecret so DCR client ids rotate with it", () => {
    const auth = signedTokenAuth({
      secret: [HARNESS_CODE_SECRET, OLD_SECRET],
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    assert.deepEqual(auth.codeSecret, [HARNESS_CODE_SECRET, OLD_SECRET]);
  });

  it("rejects an empty list, an oversized list and a weak entry at construction", () => {
    const base = { resolveUser: async () => null, loginUrl: () => "/login" };
    assert.throws(() => signedTokenAuth({ ...base, secret: [] }), /1 to 8 entries/);
    assert.throws(
      () =>
        signedTokenAuth({
          ...base,
          secret: Array.from({ length: 9 }, (_, i) => `${HARNESS_CODE_SECRET}-${i}`),
        }),
      /1 to 8 entries/,
    );
    assert.throws(
      () => signedTokenAuth({ ...base, secret: [HARNESS_CODE_SECRET, "short"] }),
      /at least 32/,
    );
  });

  it("copies the list, so changing the caller's array later changes nothing", async () => {
    const secrets = [HARNESS_CODE_SECRET];
    const auth = signedTokenAuth({
      secret: secrets,
      resolveUser: async () => null,
      loginUrl: () => "/login",
    });
    secrets[0] = OLD_SECRET;
    const token = (await auth.mintAccessToken(GRANT)).accessToken;
    assert.equal((await auth.verifyToken(token, REQUEST))?.userId, "alice");
  });
});
