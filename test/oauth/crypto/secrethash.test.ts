import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hashClientSecret,
  verifyClientSecret,
  verifyClientSecretAny,
} from "../../../src/oauth/crypto/secrethash.js";

const CODE_SECRET = "code-secret-value-32-characters-long-enough";

describe("hashClientSecret / verifyClientSecret", () => {
  it("verifies a secret against its own hash", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.equal(await verifyClientSecret("client-secret-1", hash, CODE_SECRET), true);
  });

  it("rejects the wrong secret against a real hash", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.equal(await verifyClientSecret("wrong-secret", hash, CODE_SECRET), false);
  });

  it("rejects the right secret hashed/verified under a different codeSecret", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.equal(
      await verifyClientSecret("client-secret-1", hash, "a-different-code-secret-value"),
      false,
    );
  });

  it("is deterministic — same secret and codeSecret always produce the same hash", async () => {
    const a = await hashClientSecret("client-secret-1", CODE_SECRET);
    const b = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.equal(a, b);
  });

  it("produces a different hash for a different secret", async () => {
    const a = await hashClientSecret("client-secret-1", CODE_SECRET);
    const b = await hashClientSecret("client-secret-2", CODE_SECRET);
    assert.notEqual(a, b);
  });

  it("produces a different hash for a different codeSecret (domain separation from other sealed uses)", async () => {
    const a = await hashClientSecret("client-secret-1", CODE_SECRET);
    const b = await hashClientSecret("client-secret-1", "a-different-code-secret-value");
    assert.notEqual(a, b);
  });

  it("never authenticates an empty presented or stored value", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.equal(await verifyClientSecret("", hash, CODE_SECRET), false);
    assert.equal(await verifyClientSecret("client-secret-1", "", CODE_SECRET), false);
    assert.equal(await verifyClientSecret("", "", CODE_SECRET), false);
  });

  it("prefixes the hash so its format is self-describing", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    assert.ok(hash.startsWith("hmac-sha256$"), hash);
  });
});

describe("verifyClientSecretAny (key rotation)", () => {
  const OLD_CODE_SECRET = "old-code-secret-value-32-characters-longer!";

  it("verifies a hash produced under an older codeSecret, reporting its index", async () => {
    const hash = await hashClientSecret("client-secret-1", OLD_CODE_SECRET);
    const result = await verifyClientSecretAny("client-secret-1", hash, [
      CODE_SECRET,
      OLD_CODE_SECRET,
    ]);
    assert.deepEqual(result, { ok: true, keyIndex: 1 });
  });

  it("reports keyIndex 0 when the primary (first) codeSecret produced the hash", async () => {
    const hash = await hashClientSecret("client-secret-1", CODE_SECRET);
    const result = await verifyClientSecretAny("client-secret-1", hash, [
      CODE_SECRET,
      OLD_CODE_SECRET,
    ]);
    assert.deepEqual(result, { ok: true, keyIndex: 0 });
  });

  it("returns ok: false, keyIndex: null when no configured codeSecret matches", async () => {
    const hash = await hashClientSecret("client-secret-1", "a-third-unrelated-code-secret!!");
    const result = await verifyClientSecretAny("client-secret-1", hash, [
      CODE_SECRET,
      OLD_CODE_SECRET,
    ]);
    assert.deepEqual(result, { ok: false, keyIndex: null });
  });
});

describe("derived-key caching", () => {
  it("re-derives the HKDF key at most once per codeSecretValue across repeated hashClientSecret calls", async () => {
    const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    let importKeyCalls = 0;
    crypto.subtle.importKey = ((...args: Parameters<typeof originalImportKey>) => {
      importKeyCalls += 1;
      return originalImportKey(...args);
    }) as typeof crypto.subtle.importKey;

    try {
      const distinctCodeSecret = "cache-test-code-secret-value-32-characters!";
      await hashClientSecret("client-secret-a", distinctCodeSecret);
      await hashClientSecret("client-secret-b", distinctCodeSecret);
      await hashClientSecret("client-secret-c", distinctCodeSecret);
      assert.equal(importKeyCalls, 1);
    } finally {
      crypto.subtle.importKey = originalImportKey;
    }
  });
});
