import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizationServerMetadata, protectedResourceMetadata } from "../src/oauth/metadata.js";
import {
  canonicalResource,
  normalizeConfiguredPath,
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
    assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
  });

  it("advertises only the configured token endpoint auth methods", () => {
    const publicOnly = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.deepEqual(publicOnly.token_endpoint_auth_methods_supported, ["none"]);

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
    assert.equal(withDcr.registration_endpoint, "https://example.test/mcp/oauth/register");

    const withoutDcr = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      dcrEnabled: false,
    });
    assert.equal(withoutDcr.registration_endpoint, undefined);
  });

  it("advertises revocation_endpoint only when enabled", () => {
    const off = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
    });
    assert.equal(off.revocation_endpoint, undefined);
    assert.equal(off.revocation_endpoint_auth_methods_supported, undefined);

    const on = authorizationServerMetadata({
      origin: "https://example.test",
      grantTypes: ["authorization_code"],
      revocationEnabled: true,
    });
    assert.equal(on.revocation_endpoint, "https://example.test/mcp/oauth/revoke");
    assert.deepEqual(on.revocation_endpoint_auth_methods_supported, ["none"]);
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
    assert.equal(resourcesEqual("https://Example.TEST/mcp/", "https://example.test/mcp"), true);
    assert.equal(resourcesEqual("https://evil.test/mcp", "https://example.test/mcp"), false);
  });

  it("resourcesEqual rejects fragments and distinguishes query", () => {
    assert.equal(
      resourcesEqual("https://example.test/mcp#evil", "https://example.test/mcp"),
      false,
    );
    assert.equal(
      resourcesEqual("https://example.test/mcp?tenant=a", "https://example.test/mcp"),
      false,
    );
  });

  it("canonicalResource normalizes a trailing slash in resourcePath itself", () => {
    // The bug this guards: canonicalResource used to NOT strip a trailing
    // slash on its own resourcePath argument, while resourcesEqual (via
    // normalizeResource) always strips one on the URI it's comparing
    // against — so a configured "/mcp/" silently failed to match every
    // real request's resource, no matter what the request sent.
    assert.equal(
      canonicalResource("https://example.test", "/mcp/"),
      canonicalResource("https://example.test", "/mcp"),
    );
    assert.equal(canonicalResource("https://example.test", "/mcp/"), "https://example.test/mcp");
  });

  it("resourcesEqual matches a request against a canonicalResource built from a trailing-slash resourcePath", () => {
    const expected = canonicalResource("https://example.test", "/mcp/");
    assert.equal(resourcesEqual("https://example.test/mcp", expected), true);
  });
});

describe("normalizeConfiguredPath", () => {
  it("strips one or more trailing slashes", () => {
    assert.equal(normalizeConfiguredPath("/mcp/"), "/mcp");
    assert.equal(normalizeConfiguredPath("/mcp///"), "/mcp");
    assert.equal(normalizeConfiguredPath("/mcp"), "/mcp");
  });

  it("leaves the root path as-is", () => {
    assert.equal(normalizeConfiguredPath("/"), "/");
  });
});
