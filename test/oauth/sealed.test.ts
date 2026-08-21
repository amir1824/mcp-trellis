import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seal, unseal } from "../../src/oauth/sealed.js";

const SECRET = "sealed-test-secret-value-32-characters-long";

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
