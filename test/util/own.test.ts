import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ownValue } from "../../src/util/own.js";

describe("ownValue", () => {
  const table = { known: 1 };

  it("returns an own property", () => {
    assert.equal(ownValue(table, "known"), 1);
  });

  it("never answers from Object.prototype", () => {
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      assert.equal(ownValue(table, key), undefined, key);
    }
  });

  it("returns undefined for a missing key", () => {
    assert.equal(ownValue(table, "missing"), undefined);
  });
});
