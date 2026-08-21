import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedOrigin } from "../../src/adapters/origins.js";

describe("isAllowedOrigin", () => {
  it("admits everything when the list is empty or omitted", () => {
    assert.equal(isAllowedOrigin("https://anywhere.test"), true);
    assert.equal(isAllowedOrigin("https://anywhere.test", { allowedOrigins: [] }), true);
  });

  it('admits everything when the list is ["*"]', () => {
    assert.equal(isAllowedOrigin("https://anywhere.test", { allowedOrigins: ["*"] }), true);
  });

  it("matches exact origins after URL.origin normalization", () => {
    assert.equal(
      isAllowedOrigin("https://acme.example.com", {
        allowedOrigins: ["https://acme.example.com"],
      }),
      true,
    );
    assert.equal(
      isAllowedOrigin("https://Acme.Example.com", {
        allowedOrigins: ["https://acme.example.com"],
      }),
      true,
    );
    assert.equal(
      isAllowedOrigin("https://acme.example.com:443", {
        allowedOrigins: ["https://acme.example.com"],
      }),
      true,
    );
  });

  it("admits https subdomains for *.example.com wildcards", () => {
    assert.equal(
      isAllowedOrigin("https://acme.example.com", {
        allowedOrigins: ["*.example.com"],
      }),
      true,
    );
  });

  it("rejects the apex, http, and lookalike hosts for wildcards", () => {
    const opts = { allowedOrigins: ["*.example.com"] };
    assert.equal(isAllowedOrigin("https://example.com", opts), false);
    assert.equal(isAllowedOrigin("http://acme.example.com", opts), false);
    assert.equal(isAllowedOrigin("https://evilexample.com", opts), false);
    assert.equal(isAllowedOrigin("https://acme.example.com.evil.com", opts), false);
  });
});
