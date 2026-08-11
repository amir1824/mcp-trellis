import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickProtocolVersion } from "../src/protocol.js";

describe("protocol negotiation", () => {
  it("accepts known versions", () => {
    assert.equal(
      pickProtocolVersion({ protocolVersion: "2025-06-18" }),
      "2025-06-18",
    );
  });
  it("falls back for unknown", () => {
    assert.equal(
      pickProtocolVersion({ protocolVersion: "1999-01-01" }),
      "2024-11-05",
    );
  });
});
