import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownValue } from "../../src/util/own.js";

describe("ownValue", () => {
  const table = { known: 1 };

  it("returns an own property", () => {
    assert.equal(ownValue(table, "known"), 1);
  });

  it("never answers from Object.prototype", () => {
    const inherited = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];
    assert.deepEqual(
      inherited.map((key) => ownValue(table, key)),
      inherited.map(() => undefined),
    );
  });

  it("returns undefined for a missing key", () => {
    assert.equal(ownValue(table, "missing"), undefined);
  });
});
