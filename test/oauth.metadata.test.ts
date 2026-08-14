import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
} from "../src/oauth/metadata.js";
import {
  canonicalResource,
  resourcesEqual,
} from "../src/oauth/resource.js";

describe("metadata grant derivation", () => {
  it("advertises only configured grants", () => {
    const as = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.deepEqual(as.grant_types_supported, ["authorization_code"]);
    assert.ok(!as.grant_types_supported.includes("refresh_token"));
    assert.equal(as.resource_parameter_supported, true);
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

  it("advertises only the configured token endpoint auth methods", () => {
    const publicOnly = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.deepEqual(publicOnly.token_endpoint_auth_methods_supported, [
      "none",
    ]);

    const confidential = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      tokenEndpointAuthMethods: ["none", "client_secret_basic"],
    });
    assert.deepEqual(confidential.token_endpoint_auth_methods_supported, [
      "none",
      "client_secret_basic",
    ]);
  });

  it("advertises registration_endpoint by default, omits it when DCR is disabled", () => {
    const withDcr = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.equal(
      withDcr.registration_endpoint,
      "https://example.test/mcp/oauth/register",
    );

    const withoutDcr = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      dcrEnabled: false,
    });
    assert.equal(withoutDcr.registration_endpoint, undefined);
  });

  it("builds PRM resource URL", () => {
    const prm = protectedResourceMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      resourcePath: "/mcp",
    });
    assert.equal(prm.resource, "https://example.test/mcp");
    assert.equal(canonicalResource("https://example.test", "/mcp"), prm.resource);
  });

  it("resourcesEqual ignores trailing slash and host case", () => {
    assert.equal(
      resourcesEqual("https://Example.TEST/mcp/", "https://example.test/mcp"),
      true,
    );
    assert.equal(
      resourcesEqual("https://evil.test/mcp", "https://example.test/mcp"),
      false,
    );
  });

  it("resourcesEqual rejects fragments and distinguishes query", () => {
    assert.equal(
      resourcesEqual(
        "https://example.test/mcp#evil",
        "https://example.test/mcp",
      ),
      false,
    );
    assert.equal(
      resourcesEqual(
        "https://example.test/mcp?tenant=a",
        "https://example.test/mcp",
      ),
      false,
    );
  });
});
