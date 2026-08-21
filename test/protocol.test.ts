import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickProtocolVersion } from "../src/protocol.js";

describe("protocol negotiation", () => {
  it("accepts known versions", () => {
    assert.equal(pickProtocolVersion({ protocolVersion: "2025-06-18" }), "2025-06-18");
  });
  it("falls back to the newest supported version for unknown or missing", () => {
    assert.equal(pickProtocolVersion({ protocolVersion: "1999-01-01" }), "2025-06-18");
    assert.equal(pickProtocolVersion(undefined), "2025-06-18");
    assert.equal(pickProtocolVersion({}), "2025-06-18");
  });

  it("still accepts older supported versions explicitly, unaffected by the default change", () => {
    assert.equal(pickProtocolVersion({ protocolVersion: "2024-11-05" }), "2024-11-05");
    assert.equal(pickProtocolVersion({ protocolVersion: "2025-03-26" }), "2025-03-26");
  });
});
