import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipText } from "../../src/util/clip.js";

describe("clipText", () => {
  it("returns a short value untouched, with no suffix", () => {
    assert.equal(clipText("abc", 5, "…"), "abc");
    assert.equal(clipText("abcde", 5, "…"), "abcde");
  });

  it("cuts at max and appends the suffix only when it cut", () => {
    assert.equal(clipText("abcdef", 5, "…"), "abcde…");
    assert.equal(clipText("abcdef", 5), "abcde");
  });

  it("never leaves half a surrogate pair at the cut", () => {
    const value = `${"a".repeat(4)}😀tail`;
    assert.equal(clipText(value, 5), "aaaa");
    assert.equal(clipText(value, 6), "aaaa😀");
    for (let max = 1; max < value.length; max += 1) {
      const clipped = clipText(value, max);
      assert.doesNotMatch(clipped, /[\ud800-\udbff]$/, `max=${max}`);
    }
  });
});
