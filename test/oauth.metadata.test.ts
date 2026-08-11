import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../src/oauth/metadata.js";

describe("metadata grant derivation", () => {
  it("advertises only configured grants", () => {
    const as = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.deepEqual(as.grant_types_supported, ["authorization_code"]);
    assert.ok(!as.grant_types_supported.includes("refresh_token"));
  });

  it("includes refresh when configured", () => {
    const as = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code", "refresh_token"],
    });
    assert.deepEqual(as.grant_types_supported, [
      "authorization_code",
      "refresh_token",
    ]);
  });

  it("builds PRM resource URL", () => {
    const prm = protectedResourceMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      resourcePath: "/mcp",
    });
    assert.equal(prm.resource, "https://example.test/mcp");
  });
});
