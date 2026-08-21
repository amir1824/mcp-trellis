import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sha256Base64Url, verifyPkceS256 } from "../../src/oauth/pkce.js";

describe("PKCE", () => {
  it("verifies S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await sha256Base64Url(verifier);
    assert.equal(await verifyPkceS256(verifier, challenge), true);
  });

  it("rejects wrong verifier", async () => {
    const challenge = await sha256Base64Url("good-verifier");
    assert.equal(await verifyPkceS256("bad-verifier", challenge), false);
  });

  it("does not treat a Promise as truthy (async trap)", async () => {
    const challenge = await sha256Base64Url("v");
    // Must await — a bare Promise is always truthy
    const result = verifyPkceS256("v", challenge);
    assert.equal(result instanceof Promise, true);
    assert.equal(await result, true);
    assert.equal(await verifyPkceS256("nope", challenge), false);
  });
});
