import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import { signedTokenAuth } from "../../src/auth/signed-token.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";

const ORIGIN = "https://example.test";
const RESOURCE = `${ORIGIN}/mcp`;

const auth = signedTokenAuth({
  secret: HARNESS_CODE_SECRET,
  resolveUser: async () => ({ id: "alice" }),
  loginUrl: (_req, next) => `/login?next=${encodeURIComponent(next)}`,
  ttlSeconds: 60,
});

describe("signedTokenAuth", () => {
  it("round-trips mint → verify", async () => {
    const minted = await auth.mintAccessToken({
      userId: "alice",
      clientId: "c1",
      scope: "mcp",
      resource: RESOURCE,
    });
    const verified = await auth.verifyToken(minted.accessToken, new Request(RESOURCE));
    assert.deepEqual(verified, {
      userId: "alice",
      scopes: ["mcp"],
      audience: RESOURCE,
    });
    assert.equal(minted.expiresIn, 60);
  });

  it("rejects a tampered signature", async () => {
    const minted = await auth.mintAccessToken({
      userId: "alice",
      clientId: "c1",
      scope: "mcp",
      resource: RESOURCE,
    });
    const [body] = minted.accessToken.split(".");
    const bad = `${body}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    assert.equal(await auth.verifyToken(bad, new Request(RESOURCE)), null);
  });

  it("rejects a token HMAC'd with the raw secret (HKDF domain separation)", async () => {
    const minted = await auth.mintAccessToken({
      userId: "alice",
      clientId: "c1",
      scope: "mcp",
      resource: RESOURCE,
    });
    // Forge a body.sig using the raw secret as HMAC key — must not verify
    // under the HKDF-derived access-token key.
    const { bytesToBase64Url } = await import("../../src/oauth/crypto/base64url.js");
    const payload = {
      userId: "alice",
      scopes: ["mcp"],
      audience: RESOURCE,
      exp: Date.now() + 60_000,
    };
    const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(HARNESS_CODE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const forged = `${body}.${bytesToBase64Url(signature)}`;
    assert.notEqual(forged, minted.accessToken);
    assert.equal(await auth.verifyToken(forged, new Request(RESOURCE)), null);
  });

  it("throws when ttlSeconds is not a finite number > 0", () => {
    assert.throws(
      () =>
        signedTokenAuth({
          secret: HARNESS_CODE_SECRET,
          resolveUser: async () => ({ id: "alice" }),
          loginUrl: () => "/login",
          ttlSeconds: Number.NaN,
        }),
      /ttlSeconds must be a finite number > 0/,
    );
    assert.throws(
      () =>
        signedTokenAuth({
          secret: HARNESS_CODE_SECRET,
          resolveUser: async () => ({ id: "alice" }),
          loginUrl: () => "/login",
          ttlSeconds: 0,
        }),
      /ttlSeconds must be a finite number > 0/,
    );
  });

  it("rejects an expired token", async () => {
    const short = signedTokenAuth({
      secret: HARNESS_CODE_SECRET,
      resolveUser: async () => ({ id: "alice" }),
      loginUrl: () => "/login",
      ttlSeconds: 0.001,
    });
    const minted = await short.mintAccessToken({
      userId: "alice",
      clientId: "c1",
      scope: "mcp",
      resource: RESOURCE,
    });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(await short.verifyToken(minted.accessToken, new Request(RESOURCE)), null);
  });

  it("rejects non-string scope elements after HMAC verify", async () => {
    const { bytesToBase64Url } = await import("../../src/oauth/crypto/base64url.js");
    const { hkdfKey } = await import("../../src/oauth/crypto/hkdf.js");
    const key = await hkdfKey(HARNESS_CODE_SECRET, {
      info: "mcp-trellis:signed-access-token:v1",
      algorithm: { name: "HMAC", hash: "SHA-256", length: 256 },
      usage: "sign",
    });
    const payload = {
      userId: "alice",
      scopes: [1, 2],
      audience: RESOURCE,
      exp: Date.now() + 60_000,
    };
    const body = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const token = `${body}.${bytesToBase64Url(signature)}`;
    assert.equal(await auth.verifyToken(token, new Request(RESOURCE)), null);
  });

  it("createMcpApp rejects a token minted for a different resource", async () => {
    const app = createMcpApp({
      serverInfo: { name: "t", version: "1.0.0" },
      allowInMemoryCodeStore: true,
      auth,
      tools: [
        {
          name: "ping",
          description: "ping",
          inputSchema: { type: "object", properties: {} },
          scope: "mcp",
          handler: () => "ok",
        },
      ],
    });
    const wrong = await auth.mintAccessToken({
      userId: "alice",
      clientId: "c1",
      scope: "mcp",
      resource: "https://other.test/mcp",
    });
    const res = await app.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${wrong.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      }),
    );
    assert.equal(res.status, 401);
  });
});
