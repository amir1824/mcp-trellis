import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildErrorRedirectUrl,
  codeRedirect,
  errorRedirect,
} from "../../../src/oauth/endpoints/callback.js";

const callback = {
  redirectUri: "http://127.0.0.1:9/cb?keep=1",
  state: "s1",
  issuer: "https://as.test",
};

describe("client callback redirects", () => {
  it("codeRedirect keeps the callback's own query and appends code, state, iss", () => {
    const res = codeRedirect(callback, "c0de");
    assert.equal(res.status, 302);
    assert.equal(
      res.headers.get("location"),
      "http://127.0.0.1:9/cb?keep=1&code=c0de&state=s1&iss=https%3A%2F%2Fas.test",
    );
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("errorRedirect omits an empty description and an empty state", () => {
    const res = errorRedirect({ ...callback, state: "" }, "access_denied");
    assert.equal(
      res.headers.get("location"),
      "http://127.0.0.1:9/cb?keep=1&error=access_denied&iss=https%3A%2F%2Fas.test",
    );
  });

  it("buildErrorRedirectUrl matches errorRedirect and makes iss optional", () => {
    assert.equal(
      buildErrorRedirectUrl("http://127.0.0.1:9/cb", "invalid_scope", "unsupported scope: x", "s"),
      "http://127.0.0.1:9/cb?error=invalid_scope&error_description=unsupported+scope%3A+x&state=s",
    );
  });
});
