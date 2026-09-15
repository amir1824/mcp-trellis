import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seal, unseal, unsealAny } from "../../../src/oauth/crypto/sealed.js";

const SECRET = "sealed-test-secret-value-32-characters-long";
const OLD_SECRET = "old-sealed-test-secret-value-32-characters!";
const NEWER_SECRET = "newer-sealed-test-secret-value-32-character";

describe("sealed payloads", () => {
  it("round-trips a payload through the same type", async () => {
    const sealed = await seal(SECRET, "consent", { userId: "u1" });
    const payload = await unseal<{ userId: string }>(SECRET, "consent", sealed);
    assert.deepEqual(payload, { userId: "u1" });
  });

  it("never unseals under a different type — domain separation", async () => {
    const consentTicket = await seal(SECRET, "consent", { userId: "u1" });
    assert.equal(await unseal(SECRET, "client", consentTicket), null);
    assert.equal(await unseal(SECRET, "code", consentTicket), null);
  });

  it("rejects a payload sealed under a different secret", async () => {
    const sealed = await seal(SECRET, "consent", { userId: "u1" });
    assert.equal(await unseal(SECRET.split("").reverse().join(""), "consent", sealed), null);
  });

  it("rejects tampered ciphertext", async () => {
    const sealed = await seal(SECRET, "consent", { userId: "u1" });
    const [iv, ciphertext] = sealed.split(".");
    const tampered = `${iv}.${ciphertext?.slice(0, -2)}zz`;
    assert.equal(await unseal(SECRET, "consent", tampered), null);
  });

  it("produces a different ciphertext each time (random IV)", async () => {
    const a = await seal(SECRET, "consent", { userId: "u1" });
    const b = await seal(SECRET, "consent", { userId: "u1" });
    assert.notEqual(a, b);
  });

  it("rejects malformed input", async () => {
    assert.equal(await unseal(SECRET, "consent", ""), null);
    assert.equal(await unseal(SECRET, "consent", "not-a-sealed-value"), null);
  });
});

describe("unsealAny (key rotation)", () => {
  it("unseals with the first matching key, reporting its index", async () => {
    const sealed = await seal(OLD_SECRET, "code", { userId: "u1" });
    const result = await unsealAny<{ userId: string }>(
      [NEWER_SECRET, SECRET, OLD_SECRET],
      "code",
      sealed,
    );
    assert.deepEqual(result, { value: { userId: "u1" }, keyIndex: 2 });
  });

  it("reports keyIndex 0 when the primary (first) key sealed it", async () => {
    const sealed = await seal(NEWER_SECRET, "code", { userId: "u1" });
    const result = await unsealAny<{ userId: string }>(
      [NEWER_SECRET, SECRET, OLD_SECRET],
      "code",
      sealed,
    );
    assert.deepEqual(result, { value: { userId: "u1" }, keyIndex: 0 });
  });

  it("returns null when no configured key unseals it", async () => {
    const sealed = await seal("a-completely-unrelated-secret-value-here!!!", "code", { u: 1 });
    assert.equal(await unsealAny([NEWER_SECRET, SECRET, OLD_SECRET], "code", sealed), null);
  });

  it("still works with a single-element key list", async () => {
    const sealed = await seal(SECRET, "code", { u: 1 });
    assert.deepEqual(await unsealAny([SECRET], "code", sealed), { value: { u: 1 }, keyIndex: 0 });
  });
});

describe("derived-key caching", () => {
  it("re-derives the HKDF key at most once per (secret, type, usage) across repeated seal/unseal calls", async () => {
    const originalImportKey = crypto.subtle.importKey.bind(crypto.subtle);
    let importKeyCalls = 0;
    crypto.subtle.importKey = ((...args: Parameters<typeof originalImportKey>) => {
      importKeyCalls += 1;
      return originalImportKey(...args);
    }) as typeof crypto.subtle.importKey;

    try {
      const distinctSecret = "cache-test-secret-value-32-characters-long!";
      const a = await seal(distinctSecret, "code", { n: 1 });
      const b = await seal(distinctSecret, "code", { n: 2 });
      await unseal(distinctSecret, "code", a);
      await unseal(distinctSecret, "code", b);

      // Two seals share the encrypt-usage key; two unseals share the
      // decrypt-usage key — one importKey call per usage, not per call.
      assert.equal(importKeyCalls, 2);
    } finally {
      crypto.subtle.importKey = originalImportKey;
    }
  });
});
