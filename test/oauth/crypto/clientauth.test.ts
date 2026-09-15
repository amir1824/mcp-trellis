import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readClientAuth } from "../../../src/oauth/crypto/clientauth.js";

const withAuthorization = (value: string): Request =>
  new Request("https://example.test/mcp/oauth/token", { headers: { Authorization: value } });

const basic = (credentials: string): string => btoa(credentials);

describe("readClientAuth — client_secret_basic", () => {
  it("accepts the Basic scheme in any letter case (RFC 7235 §2.1)", () => {
    for (const scheme of ["Basic", "basic", "BASIC", "bAsIc"]) {
      const auth = readClientAuth(withAuthorization(`${scheme} ${basic("gemini:s3cret")}`), {});
      assert.deepEqual(
        auth,
        { clientId: "gemini", secret: "s3cret", method: "client_secret_basic" },
        `scheme ${scheme}`,
      );
    }
  });

  it("form-decodes id and secret, so + is a space (RFC 6749 §2.3.1)", () => {
    const auth = readClientAuth(withAuthorization(`Basic ${basic("my+client:a+b%2Bc%3A")}`), {});
    assert.equal(auth?.clientId, "my client");
    assert.equal(auth?.secret, "a b+c:");
  });

  it("prefers the Authorization header over body credentials", () => {
    const auth = readClientAuth(withAuthorization(`Basic ${basic("header-id:x")}`), {
      client_id: "body-id",
      client_secret: "y",
    });
    assert.equal(auth?.clientId, "header-id");
  });

  it("falls back to the body for a non-Basic or malformed header", () => {
    for (const header of ["Bearer abc", `Basic ${basic("no-separator")}`, "Basic !!!not-base64"]) {
      const auth = readClientAuth(withAuthorization(header), { client_id: "body-id" });
      assert.deepEqual(auth, { clientId: "body-id", secret: null, method: "none" }, header);
    }
  });
});
