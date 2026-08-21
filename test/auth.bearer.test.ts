import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_COMPARE_LENGTH,
  matchesAny,
  parseBearer,
  rejectQueryToken,
  timingSafeEqual,
} from "../src/auth/bearer.js";

describe("timingSafeEqual", () => {
  it("matches equal strings", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
  });
  it("rejects different strings", () => {
    assert.equal(timingSafeEqual("abc", "abd"), false);
  });
  it("rejects length mismatch", () => {
    assert.equal(timingSafeEqual("ab", "abc"), false);
  });
  it("rejects over-long inputs without comparing", () => {
    const long = "x".repeat(MAX_COMPARE_LENGTH + 1);
    assert.equal(timingSafeEqual(long, long), false);
    assert.equal(timingSafeEqual(long, "short"), false);
  });
  it("never treats two empty strings as equal — an unset stored secret must not authenticate", () => {
    assert.equal(timingSafeEqual("", ""), false);
  });
  it("rejects an empty presented value against a real secret, and vice versa", () => {
    assert.equal(timingSafeEqual("", "secret"), false);
    assert.equal(timingSafeEqual("secret", ""), false);
  });
  it("matchesAny finds a match", () => {
    assert.equal(matchesAny("tok", ["x", "tok"]), true);
    assert.equal(matchesAny("tok", ["x"]), false);
  });
  it("matchesAny never matches an empty presented value against an empty accepted entry", () => {
    assert.equal(matchesAny("", ["", "tok"]), false);
  });
  it("parseBearer extracts token", () => {
    assert.equal(parseBearer("Bearer secret"), "secret");
    assert.equal(parseBearer("Basic x"), null);
    assert.equal(parseBearer(null), null);
  });
  it("rejectQueryToken rejects token and access_token", () => {
    assert.equal(rejectQueryToken(new URL("https://example.test/mcp?token=x")), true);
    assert.equal(rejectQueryToken(new URL("https://example.test/mcp?access_token=x")), true);
    assert.equal(rejectQueryToken(new URL("https://example.test/mcp")), false);
  });
});
