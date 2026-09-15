import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickDefined } from "../../src/util/defined.js";

describe("pickDefined", () => {
  it("keeps listed keys whose value is defined, including falsy ones", () => {
    const source = { a: 0, b: false, c: "", d: null, e: "x" };
    assert.deepEqual(pickDefined(source, ["a", "b", "c", "d"]), { a: 0, b: false, c: "", d: null });
  });

  it("drops undefined values and unlisted keys", () => {
    const source: { a?: string | undefined; b?: number; c: string } = { a: undefined, c: "c" };
    const picked = pickDefined(source, ["a", "b"]);
    assert.deepEqual(picked, {});
    assert.equal(Object.hasOwn(picked, "a"), false);
  });
});
