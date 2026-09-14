import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CimdDocument, isCimdClientId, resolveCimdClient } from "../../src/oauth/cimd.js";

describe("isCimdClientId", () => {
  it("accepts https URLs without credentials or fragment", () => {
    assert.equal(isCimdClientId("https://claude.ai/oauth/client.json"), true);
  });

  it("rejects http, credentials, fragments, and non-URLs", () => {
    assert.equal(isCimdClientId("http://claude.ai/oauth/client.json"), false);
    assert.equal(isCimdClientId("https://user:pass@claude.ai/x"), false);
    assert.equal(isCimdClientId("https://claude.ai/x#frag"), false);
    assert.equal(isCimdClientId("not-a-url"), false);
  });
});

describe("resolveCimdClient", () => {
  const doc: CimdDocument = {
    client_id: "https://clients.example/claude.json",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
  };

  it("validates client_id match and redirect_uris", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "Content-Type": "application/json", "Cache-Control": "max-age=60" },
        }),
      lookup: async () => ["203.0.113.10"],
    });
    assert.deepEqual(resolved?.redirect_uris, doc.redirect_uris);
  });

  it("rejects private / loopback hostnames without fetching", async () => {
    let fetched = false;
    for (const id of [
      "https://127.0.0.1/client.json",
      "https://[::1]/client.json",
      "https://[fc00::1]/client.json",
      "https://[::ffff:127.0.0.1]/client.json",
    ]) {
      fetched = false;
      const resolved = await resolveCimdClient(id, {
        fetch: async () => {
          fetched = true;
          return new Response("{}");
        },
        lookup: async () => ["203.0.113.10"],
      });
      assert.equal(resolved, null, id);
      assert.equal(fetched, false, id);
    }
  });

  it("rejects when DNS resolves to a private address before fetch", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://evil.example/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response(JSON.stringify(doc));
      },
      lookup: async () => ["10.0.0.1"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects non-http(s) redirect_uris", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...doc,
            redirect_uris: ["javascript:alert(1)"],
          }),
        ),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });

  it("rejects confidential token_endpoint_auth_method", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(JSON.stringify({ ...doc, token_endpoint_auth_method: "client_secret_basic" })),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });

  it("rejects mismatched client_id in the document", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(JSON.stringify({ ...doc, client_id: "https://other.example/x" })),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });
});
