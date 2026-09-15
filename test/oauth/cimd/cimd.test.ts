import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type CimdDocument,
  isCimdClientId,
  resolveCimdClient,
} from "../../../src/oauth/cimd/cimd.js";

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

  it("rejects loopback IPv4 hostname without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://127.0.0.1/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects loopback IPv6 hostname without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://[::1]/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects ULA IPv6 hostname without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://[fc00::1]/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects IPv4-mapped loopback hostname without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://[::ffff:127.0.0.1]/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
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

  it("rejects non-canonical IPv4 lookup results without fetching", async () => {
    for (const address of ["127.1", "127.0.1", "10.1", "2130706433"]) {
      let fetched = false;
      const resolved = await resolveCimdClient("https://evil.example/client.json", {
        fetch: async () => {
          fetched = true;
          return new Response("{}");
        },
        lookup: async () => [address],
      });
      assert.equal(resolved, null, address);
      assert.equal(fetched, false, address);
    }
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

  it("rejects non-loopback http redirect_uris", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...doc,
            redirect_uris: ["http://evil.example/cb"],
          }),
        ),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });

  it("accepts loopback http redirect_uris", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(
          JSON.stringify({
            ...doc,
            redirect_uris: ["http://127.0.0.1:8787/cb"],
          }),
        ),
      lookup: async () => ["203.0.113.10"],
    });
    assert.deepEqual(resolved?.redirect_uris, ["http://127.0.0.1:8787/cb"]);
  });

  it("rejects NAT64 embeddings without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://evil.example/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["64:ff9b::a00:1"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects NAT64 with leading-zero hextets without fetching", async () => {
    let fetched = false;
    const resolved = await resolveCimdClient("https://evil.example/client.json", {
      fetch: async () => {
        fetched = true;
        return new Response("{}");
      },
      lookup: async () => ["064:ff9b::a00:1"],
    });
    assert.equal(resolved, null);
    assert.equal(fetched, false);
  });

  it("rejects confidential token_endpoint_auth_method", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(JSON.stringify({ ...doc, token_endpoint_auth_method: "client_secret_basic" })),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });

  it("aborts a body that stalls after headers (timeout covers the body read)", async () => {
    let aborted = false;
    let pullAfterAbort = 0;
    let cancelled = false;
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const resolved = await resolveCimdClient(doc.client_id, {
        timeoutMs: 50,
        fetch: async (_url, init) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          const stalled = new ReadableStream<Uint8Array>({
            pull: () => {
              if (aborted || cancelled) pullAfterAbort += 1;
              return new Promise(() => {});
            },
            cancel: () => {
              cancelled = true;
            },
          });
          return new Response(stalled, { status: 200 });
        },
        lookup: async () => ["203.0.113.10"],
      });
      // Let a late body-read rejection surface if the race loser was not sunk.
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(resolved, null);
      assert.equal(aborted, true);
      assert.equal(cancelled, true, "stalled body must be cancelled on timeout");
      assert.equal(rejections.length, 0, `unhandledRejection: ${String(rejections[0])}`);
      assert.equal(pullAfterAbort, 0, "pull must not keep running after abort/cancel");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects a chunked body over 5 KB without a Content-Length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: (controller) => {
              sent += 1;
              if (sent > 20) controller.close();
              else controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.ok(sent < 20, `stream should be cut early, pulled ${sent} chunks`);
  });

  it("rejects a cross-origin redirect without fetching the target", async () => {
    const urls: string[] = [];
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/claude.json" },
        });
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
    assert.deepEqual(urls, [doc.client_id]);
  });

  it("follows a same-origin redirect", async () => {
    const urls: string[] = [];
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async (url) => {
        urls.push(String(url));
        return urls.length === 1
          ? new Response(null, { status: 301, headers: { Location: "/v2/claude.json" } })
          : new Response(JSON.stringify(doc), { status: 200 });
      },
      lookup: async () => ["203.0.113.10"],
    });
    assert.deepEqual(resolved?.redirect_uris, doc.redirect_uris);
    assert.deepEqual(urls, [doc.client_id, "https://clients.example/v2/claude.json"]);
  });

  it("rejects localhost http redirect_uris (RFC 8252 §8.3)", async () => {
    const resolved = await resolveCimdClient(doc.client_id, {
      fetch: async () =>
        new Response(JSON.stringify({ ...doc, redirect_uris: ["http://localhost:8787/cb"] })),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved, null);
  });

  it("rejects reserved, multicast, 6to4, and IPv4-compatible resolutions without fetching", async () => {
    const blocked = [
      "192.0.0.8",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "ff02::1",
      "2002:7f00:1::",
      "::7f00:1",
      "::127.0.0.1",
    ];
    for (const address of blocked) {
      let fetched = false;
      const resolved = await resolveCimdClient(doc.client_id, {
        fetch: async () => {
          fetched = true;
          return new Response(JSON.stringify(doc));
        },
        lookup: async () => [address],
      });
      assert.equal(resolved, null, address);
      assert.equal(fetched, false, address);
    }
  });

  it("does not treat a DNS name with a numeric first label as an IP", async () => {
    const resolved = await resolveCimdClient("https://10.cdn.example/claude.json", {
      fetch: async () =>
        new Response(JSON.stringify({ ...doc, client_id: "https://10.cdn.example/claude.json" })),
      lookup: async () => ["203.0.113.10"],
    });
    assert.equal(resolved?.client_id, "https://10.cdn.example/claude.json");
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
