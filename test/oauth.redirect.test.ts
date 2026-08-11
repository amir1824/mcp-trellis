import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedRedirectUri, CLAUDE_CALLBACK } from "../src/oauth/redirect.js";

describe("redirect allowlist", () => {
  it("allows Claude callback and loopback", () => {
    assert.equal(isAllowedRedirectUri(CLAUDE_CALLBACK), true);
    assert.equal(isAllowedRedirectUri("http://127.0.0.1:8787/cb"), true);
    assert.equal(isAllowedRedirectUri("https://evil.example/cb"), false);
  });
});
