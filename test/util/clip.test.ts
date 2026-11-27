import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipLine, clipText } from "../../src/util/clip.js";

describe("clipLine", () => {
  it("puts a value on one line and drops invisible characters", () => {
    assert.equal(clipLine("a\r\n\tb​c", 10), "a bc");
  });

  it("cleans only the head of a huge value, and marks that it was cut", () => {
    assert.equal(clipLine(`${" ".repeat(10_000)}tail`, 8), " …");
  });
});

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
    const everyMax = Array.from({ length: value.length - 1 }, (_, index) => index + 1);
    const danglingHighSurrogates = everyMax.filter((max) =>
      /[\ud800-\udbff]$/.test(clipText(value, max)),
    );
    assert.deepEqual(danglingHighSurrogates, []);
  });
});
