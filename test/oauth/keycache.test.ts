import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBoundedCache } from "../../src/oauth/keycache.js";

describe("createBoundedCache", () => {
  it("returns undefined for a key never set", () => {
    const cache = createBoundedCache<string>(4);
    assert.equal(cache.get("missing"), undefined);
  });

  it("returns what was set", () => {
    const cache = createBoundedCache<string>(4);
    cache.set("a", "1");
    assert.equal(cache.get("a"), "1");
  });

  it("overwrites an existing key without evicting anything", () => {
    const cache = createBoundedCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("a", "1-updated");
    assert.equal(cache.get("a"), "1-updated");
    assert.equal(cache.get("b"), "2");
  });

  it("evicts the oldest entry once the limit is exceeded", () => {
    const cache = createBoundedCache<string>(2);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "2");
    assert.equal(cache.get("c"), "3");
  });

  it("never grows past the limit across many insertions", () => {
    const cache = createBoundedCache<number>(3);
    for (let i = 0; i < 100; i += 1) cache.set(`k${i}`, i);
    // Only the last 3 keys should still be present.
    assert.equal(cache.get("k96"), undefined);
    assert.equal(cache.get("k97"), 97);
    assert.equal(cache.get("k98"), 98);
    assert.equal(cache.get("k99"), 99);
  });
});
