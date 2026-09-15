import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBoundedCache, settleCached } from "../../../src/oauth/crypto/keycache.js";

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
    cache.set("k0", 0);
    cache.set("k1", 1);
    cache.set("k2", 2);
    cache.set("k3", 3);
    cache.set("k4", 4);
    assert.equal(cache.get("k0"), undefined);
    assert.equal(cache.get("k1"), undefined);
    assert.equal(cache.get("k2"), 2);
    assert.equal(cache.get("k3"), 3);
    assert.equal(cache.get("k4"), 4);
  });
});

describe("settleCached", () => {
  it("drops a rejected derive so the slot is not poisoned", async () => {
    const cache = createBoundedCache<Promise<string>>(4);
    let attempts = 0;
    await assert.rejects(
      () =>
        settleCached(cache, "k", () => {
          attempts += 1;
          return Promise.reject(new Error("derive failed"));
        }),
      /derive failed/,
    );
    assert.equal(cache.get("k"), undefined);

    const value = await settleCached(cache, "k", () => {
      attempts += 1;
      return Promise.resolve("ok");
    });
    assert.equal(value, "ok");
    assert.equal(attempts, 2);
    assert.equal(await cache.get("k"), "ok");
  });

  it("does not delete a newer entry when an older derive rejects late", async () => {
    const cache = createBoundedCache<Promise<string>>(4);
    let rejectOlder!: (error: Error) => void;
    const olderSettling = settleCached(
      cache,
      "k",
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectOlder = reject;
        }),
    );

    const newer = Promise.resolve("newer");
    cache.set("k", newer);

    rejectOlder(new Error("older failed"));
    await assert.rejects(() => olderSettling, /older failed/);

    assert.equal(cache.get("k"), newer);
    assert.equal(await cache.get("k"), "newer");
  });
});
