import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  timingSafeEqual,
  matchesAny,
  parseBearer,
  rejectQueryToken,
  MAX_COMPARE_LENGTH,
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
  it("matchesAny finds a match", () => {
    assert.equal(matchesAny("tok", ["x", "tok"]), true);
    assert.equal(matchesAny("tok", ["x"]), false);
  });
  it("parseBearer extracts token", () => {
    assert.equal(parseBearer("Bearer secret"), "secret");
    assert.equal(parseBearer("Basic x"), null);
    assert.equal(parseBearer(null), null);
  });
  it("rejectQueryToken rejects token and access_token", () => {
    assert.equal(
      rejectQueryToken(new URL("https://example.test/mcp?token=x")),
      true,
    );
    assert.equal(
      rejectQueryToken(new URL("https://example.test/mcp?access_token=x")),
      true,
    );
    assert.equal(
      rejectQueryToken(new URL("https://example.test/mcp")),
      false,
    );
  });
});
