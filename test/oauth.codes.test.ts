import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeAuthCode, issueAuthCode } from "../src/oauth/codes.js";
import { CLAUDE_CALLBACK } from "../src/oauth/redirect.js";

const RESOURCE = "https://example.test/mcp";

const baseRecord = {
  clientId: "c1",
  redirectUri: CLAUDE_CALLBACK,
  codeChallenge: "challenge",
  userId: "user-1",
  resource: RESOURCE,
  scope: "mcp",
};

/**
 * Reproduces the exact v1 wire format `codes.ts` used to mint before the
 * AES-GCM (`sealed.ts`) migration — HMAC-SHA256 over `base64url(JSON)`,
 * joined with `.`. Deliberately independent of the current implementation:
 * this is a contract test on the wire format an already-deployed instance
 * could still be producing during a rolling upgrade, not a test of internal
 * reuse. If this ever needs to change, the compatibility window is closing
 * on purpose (see `codes.ts`'s module docstring) — remove it there first.
 */
const mintLegacyV1Code = async (
  secret: string,
  record: typeof baseRecord,
  nowMs = Date.now(),
): Promise<string> => {
  const body = { ...record, exp: nowMs + 600_000, jti: crypto.randomUUID() };
  const payload = Buffer.from(JSON.stringify(body), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sigB64 = Buffer.from(sig)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payload}.${sigB64}`;
};

describe("sealed auth codes (v2)", () => {
  const secret = "test-hmac-secret-key";

  it("issues and consumes a valid code", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    const record = await consumeAuthCode(secret, code);
    assert.ok(record);
    assert.equal(record.userId, "user-1");
    assert.equal(record.clientId, "c1");
    assert.equal(record.resource, RESOURCE);
    assert.equal(record.scope, "mcp");
  });

  it("carries a multi-scope grant through issue and consume", async () => {
    const code = await issueAuthCode(secret, {
      ...baseRecord,
      scope: "mcp read",
    });
    const record = await consumeAuthCode(secret, code);
    assert.equal(record?.scope, "mcp read");
  });

  it("rejects a code whose payload has no scope", async () => {
    const withoutScope: Partial<typeof baseRecord> = { ...baseRecord };
    delete withoutScope.scope;
    const code = await issueAuthCode(secret, withoutScope as typeof baseRecord);
    assert.equal(await consumeAuthCode(secret, code), null);
  });

  it("rejects tampered code", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    const tampered = `${code.slice(0, -4)}xxxx`;
    assert.equal(await consumeAuthCode(secret, tampered), null);
  });

  it("rejects expired code", async () => {
    const code = await issueAuthCode(secret, baseRecord, Date.now() - 700_000);
    assert.equal(await consumeAuthCode(secret, code), null);
  });

  it("enforces single-use via codeStore", async () => {
    const used = new Set<string>();
    const codeStore = {
      consume: (jti: string, _expMs: number) => {
        if (used.has(jti)) return false;
        used.add(jti);
        return true;
      },
    };
    const code = await issueAuthCode(secret, baseRecord);
    assert.ok(await consumeAuthCode(secret, code, { codeStore }));
    assert.equal(await consumeAuthCode(secret, code, { codeStore }), null);
  });

  it("enforces single-use by default without codeStore", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    assert.ok(await consumeAuthCode(secret, code));
    assert.equal(await consumeAuthCode(secret, code), null);
  });

  it("issues codes with the v2 sealed prefix, not the legacy HMAC format", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    assert.ok(code.startsWith("v2."), `expected a v2.-prefixed code, got: ${code.slice(0, 10)}…`);
    // v1 was exactly two dot-separated parts (payload.sig); v2 has three
    // (v2.iv.ciphertext) — pin the shape, not just the prefix.
    assert.equal(code.split(".").length, 3);
  });

  it("v2 codes are opaque — the plaintext record is not recoverable without codeSecret", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    // v1's payload segment was `base64url(JSON.stringify(record))` — readable
    // by design inspection, no secret needed. v2 must not leak this.
    assert.doesNotMatch(code, /user-1/);
    assert.doesNotMatch(code, RegExp(baseRecord.resource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("v1 auth codes are rejected since 1.0", () => {
  const secret = "rolling-deploy-shared-secret-32c";

  it("rejects a legacy HMAC (v1) code — soft migration window closed", async () => {
    const code = await mintLegacyV1Code(secret, baseRecord);
    assert.ok(!code.startsWith("v2."), "sanity: this helper must reproduce the old format");
    assert.equal(await consumeAuthCode(secret, code), null);
  });

  it("still redeems a v2 sealed code", async () => {
    const code = await issueAuthCode(secret, baseRecord);
    assert.ok(code.startsWith("v2."));
    assert.ok(await consumeAuthCode(secret, code));
  });
});
