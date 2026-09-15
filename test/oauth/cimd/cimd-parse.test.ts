import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCacheMaxAge, parseDocument } from "../../../src/oauth/cimd/cimd-parse.js";

const CLIENT_ID = "https://clients.example/claude.json";
const valid = {
  client_id: CLIENT_ID,
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
};
const parse = (doc: unknown) => () => parseDocument(CLIENT_ID, JSON.stringify(doc));

describe("parseDocument — CIMD document validation", () => {
  it("accepts a minimal public client and normalizes its auth method", () => {
    assert.deepEqual(
      parseDocument(CLIENT_ID, JSON.stringify({ ...valid, client_name: "Claude" })),
      {
        ...valid,
        client_name: "Claude",
        token_endpoint_auth_method: "none",
      },
    );
  });

  it("drops a non-string client_name", () => {
    assert.equal(parse({ ...valid, client_name: 42 })().client_name, undefined);
  });

  it("rejects a body that is not JSON", () => {
    assert.throws(() => parseDocument(CLIENT_ID, "<html>"), /not JSON/);
  });

  it("rejects JSON that is not an object", () => {
    for (const body of [null, [], "string", 7]) {
      assert.throws(parse(body), /must be a JSON object/, JSON.stringify(body));
    }
  });

  it("rejects a client_id that differs from the fetched URL in any way", () => {
    for (const clientId of [`${CLIENT_ID}?x=1`, CLIENT_ID.toUpperCase(), undefined]) {
      assert.throws(parse({ ...valid, client_id: clientId }), /must equal the request URL/);
    }
  });

  it("rejects a confidential token_endpoint_auth_method", () => {
    assert.throws(
      parse({ ...valid, token_endpoint_auth_method: "client_secret_post" }),
      /must be public/,
    );
  });

  it("requires a non-empty redirect_uris array", () => {
    for (const redirectUris of [undefined, [], "https://claude.ai/cb"]) {
      assert.throws(parse({ ...valid, redirect_uris: redirectUris }), /non-empty redirect_uris/);
    }
  });

  it("caps redirect_uris at 10 entries", () => {
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://app.example/cb${i}`);
    assert.doesNotThrow(parse({ ...valid, redirect_uris: uris(10) }));
    assert.throws(parse({ ...valid, redirect_uris: uris(11) }), /at most 10/);
  });

  it("rejects non-string or empty redirect_uris entries", () => {
    for (const entry of [42, null, ""]) {
      assert.throws(parse({ ...valid, redirect_uris: [entry] }), /must be strings/);
    }
  });

  it("rejects relative redirect_uris", () => {
    assert.throws(parse({ ...valid, redirect_uris: ["/cb"] }), /absolute URLs/);
  });

  it("rejects redirect_uris carrying credentials or a fragment", () => {
    for (const uri of ["https://user:pw@app.example/cb", "https://app.example/cb#frag"]) {
      assert.throws(parse({ ...valid, redirect_uris: [uri] }), /credentials or a fragment/, uri);
    }
  });

  it("allows http only for loopback IPs, never localhost", () => {
    assert.doesNotThrow(parse({ ...valid, redirect_uris: ["http://[::1]:8787/cb"] }));
    assert.throws(parse({ ...valid, redirect_uris: ["http://localhost:8787/cb"] }), /loopback/);
  });

  it("rejects non-http(s) schemes", () => {
    assert.throws(parse({ ...valid, redirect_uris: ["myapp://cb"] }), /must be http\(s\)/);
  });
});

describe("parseCacheMaxAge", () => {
  it("defaults to 300s without a usable max-age", () => {
    assert.equal(parseCacheMaxAge(null), 300);
    assert.equal(parseCacheMaxAge("no-store"), 300);
  });

  it("reads max-age and caps it at one hour", () => {
    assert.equal(parseCacheMaxAge("public, max-age=60"), 60);
    assert.equal(parseCacheMaxAge("max-age=999999"), 3600);
  });
});
