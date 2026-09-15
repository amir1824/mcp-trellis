import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedOrigin, isAllowedRequestOrigin } from "../../src/http/origins.js";

describe("isAllowedOrigin", () => {
  it("admits any origin when the list is empty or omitted", () => {
    assert.equal(isAllowedOrigin("https://anywhere.test"), true);
    assert.equal(isAllowedOrigin("https://anywhere.test", { allowedOrigins: [] }), true);
  });

  it("admits any origin when the list contains *", () => {
    assert.equal(isAllowedOrigin("https://anywhere.test", { allowedOrigins: ["*"] }), true);
  });

  it("matches exact origins (case-insensitive host, default https port)", () => {
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

  it("matches https subdomain wildcards", () => {
    assert.equal(
      isAllowedOrigin("https://acme.example.com", {
        allowedOrigins: ["*.example.com"],
      }),
      true,
    );
  });

  it("rejects apex, http, and lookalike hosts for wildcards", () => {
    const opts = { allowedOrigins: ["*.example.com"] };
    assert.equal(isAllowedOrigin("https://example.com", opts), false);
    assert.equal(isAllowedOrigin("http://acme.example.com", opts), false);
    assert.equal(isAllowedOrigin("https://evilexample.com", opts), false);
    assert.equal(isAllowedOrigin("https://acme.example.com.evil.com", opts), false);
  });
});

describe("isAllowedRequestOrigin", () => {
  it("admits requests with no Origin header", () => {
    assert.equal(isAllowedRequestOrigin(null), true);
    assert.equal(isAllowedRequestOrigin(null, ["https://app.example"]), true);
  });

  it("rejects a present Origin when the allowlist is omitted or empty", () => {
    assert.equal(isAllowedRequestOrigin("https://evil.example"), false);
    assert.equal(isAllowedRequestOrigin("https://evil.example", []), false);
  });

  it("admits * and exact matches", () => {
    assert.equal(isAllowedRequestOrigin("https://evil.example", ["*"]), true);
    assert.equal(isAllowedRequestOrigin("https://app.example", ["https://app.example"]), true);
    assert.equal(isAllowedRequestOrigin("https://evil.example", ["https://app.example"]), false);
  });
});
