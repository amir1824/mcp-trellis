import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashClientSecret, verifyClientSecret } from "../src/oauth/secrethash.js";

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
