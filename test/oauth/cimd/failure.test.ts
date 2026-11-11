/**
 * Why a CIMD document did not resolve: every failure carries a code the
 * operator's audit sink sees, while the connector keeps one generic error.
 */

import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, mock } from "node:test";
import { resolveCimdOutcome } from "../../../src/oauth/cimd/cimd.js";
import { defaultLookup } from "../../../src/oauth/cimd/dns.js";
import { CimdError } from "../../../src/oauth/cimd/failure.js";
import type { OAuthAuditEntry } from "../../../src/oauth/types.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const CLIENT_ID = "https://clients.example/client.json";
const PUBLIC_LOOKUP = async () => ["203.0.113.10"];
const doc = {
  client_id: CLIENT_ID,
  redirect_uris: ["https://clients.example/callback"],
  token_endpoint_auth_method: "none",
};

const outcomeFor = (respond: () => Response, lookup = PUBLIC_LOOKUP) =>
  resolveCimdOutcome(CLIENT_ID, { fetch: async () => respond(), lookup });

describe("resolveCimdOutcome failure codes", () => {
  it("reports a non-2xx status with the status number only", async () => {
    const outcome = await outcomeFor(() => new Response("secret body", { status: 403 }));
    assert.deepEqual(outcome, { failure: { code: "http_status", detail: "status 403" } });
  });

  it("reports a body that is not JSON", async () => {
    const outcome = await outcomeFor(() => new Response("<html>"));
    assert.deepEqual(outcome, {
      failure: { code: "not_json", detail: "CIMD document is not JSON" },
    });
  });

  it("reports a document whose client_id differs from the URL", async () => {
    const outcome = await outcomeFor(
      () => new Response(JSON.stringify({ ...doc, client_id: "https://other.example/x" })),
    );
    assert.ok("failure" in outcome);
    assert.equal(outcome.failure.code, "client_id_mismatch");
  });

  it("reports a document that cannot be public", async () => {
    const outcome = await outcomeFor(
      () =>
        new Response(
          JSON.stringify({ ...doc, token_endpoint_auth_methods_supported: ["private_key_jwt"] }),
        ),
    );
    assert.ok("failure" in outcome);
    assert.equal(outcome.failure.code, "auth_method_unsupported");
  });

  it("reports unusable redirect_uris", async () => {
    const outcome = await outcomeFor(
      () => new Response(JSON.stringify({ ...doc, redirect_uris: [] })),
    );
    assert.ok("failure" in outcome);
    assert.equal(outcome.failure.code, "redirect_uris_invalid");
  });

  it("reports a non-public resolution without leaking the address", async () => {
    const outcome = await outcomeFor(
      () => new Response("{}"),
      async () => ["10.0.0.1"],
    );
    assert.deepEqual(outcome, {
      failure: { code: "blocked_address", detail: "CIMD resolved to a non-public address" },
    });
  });

  it("reports a redirect to another origin as refused", async () => {
    const outcome = await outcomeFor(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    assert.deepEqual(outcome, {
      failure: { code: "redirect_refused", detail: "cross-origin redirect" },
    });
  });

  it("reports a body over the cap", async () => {
    const outcome = await outcomeFor(() => new Response("x".repeat(6 * 1024)));
    assert.deepEqual(outcome, { failure: { code: "too_large" } });
  });

  it("keeps only the class name of an unexpected fetch error", async () => {
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED 10.1.2.3:443");
      },
      lookup: PUBLIC_LOOKUP,
    });
    assert.deepEqual(outcome, { failure: { code: "fetch_failed", detail: "TypeError" } });
  });

  it("resolves a good document", async () => {
    const outcome = await outcomeFor(() => new Response(JSON.stringify(doc)));
    assert.ok("doc" in outcome);
    assert.deepEqual(outcome.doc.redirect_uris, doc.redirect_uris);
  });

  it("reports a body that stalls past the hop timeout as timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
    });
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => new Response(stalled),
      lookup: PUBLIC_LOOKUP,
      timeoutMs: 20,
    });
    assert.deepEqual(outcome, { failure: { code: "timeout" } });
  });

  it("stops after three same-origin redirects", async () => {
    let fetches = 0;
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 302, headers: { location: "/next.json" } });
      },
      lookup: PUBLIC_LOOKUP,
    });
    assert.deepEqual(outcome, {
      failure: { code: "redirect_refused", detail: "too many redirects" },
    });
    assert.equal(fetches, 4);
  });

  it("reports a host lookup that throws as dns_failed, not as a fetch failure", async () => {
    const outcome = await outcomeFor(
      () => new Response(JSON.stringify(doc)),
      async () => {
        throw new Error("NXDOMAIN for clients.example");
      },
    );
    assert.deepEqual(outcome, {
      failure: { code: "dns_failed", detail: "DNS lookup failed (unknown)" },
    });
  });

  it("keeps a host lookup's resolver error code", async () => {
    const outcome = await outcomeFor(
      () => new Response(JSON.stringify(doc)),
      async () => {
        throw Object.assign(new Error("queryA ETIMEOUT"), { code: "ETIMEOUT" });
      },
    );
    assert.deepEqual(outcome, {
      failure: { code: "dns_failed", detail: "DNS lookup failed (ETIMEOUT)" },
    });
  });

  it("reports a host lookup with no addresses as dns_failed, not as blocked", async () => {
    const outcome = await outcomeFor(
      () => new Response(JSON.stringify(doc)),
      async () => [],
    );
    assert.deepEqual(outcome, {
      failure: { code: "dns_failed", detail: "DNS lookup returned no addresses" },
    });
  });

  it("resolves an IP-literal client_id without a DNS lookup", async () => {
    const ipClientId = "https://203.0.113.7/client.json";
    const outcome = await resolveCimdOutcome(ipClientId, {
      fetch: async () => new Response(JSON.stringify({ ...doc, client_id: ipClientId })),
      lookup: async () => {
        throw new Error("lookup must not run for an IP literal");
      },
    });
    assert.ok("doc" in outcome);
  });

  it("returns a valid document when the cache write fails", async () => {
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => new Response(JSON.stringify(doc)),
      lookup: PUBLIC_LOOKUP,
      cache: {
        get: async () => null,
        set: async () => {
          throw new Error("cache down");
        },
      },
    });
    assert.ok("doc" in outcome);
  });
});

describe("CIMD failure audit at /authorize", () => {
  it("records the code for the operator and answers the connector generically", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      cimd: true,
      cimdLookup: async () => ["10.0.0.1"],
      ports: stubPorts({ audit: (entry) => void entries.push(entry) }),
    });
    const url = new URL(`${DEFAULT_ORIGIN}/mcp/oauth/authorize`);
    url.searchParams.set("client_id", CLIENT_ID);
    const res = await router.tryHandle(new Request(url));
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: "unauthorized_client",
      error_description: "CIMD client_id could not be resolved",
    });
    assert.deepEqual(entries, [
      {
        event: "cimd_resolve_failed",
        clientId: CLIENT_ID,
        reason: "blocked_address: CIMD resolved to a non-public address (authorize)",
      },
    ]);
  });
});

describe("defaultLookup (resolve4 and resolve6, never dns.lookup)", () => {
  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  it("resolves A and AAAA records without touching the getaddrinfo thread pool", async () => {
    const lookup = mock.method(dns, "lookup", async () => {
      throw new Error("dns.lookup must not be used");
    });
    mock.method(dns, "resolve4", async () => ["203.0.113.5"]);
    mock.method(dns, "resolve6", async () => ["2001:db8::5"]);
    syncBuiltinESMExports();

    assert.deepEqual(await defaultLookup("clients.example"), ["203.0.113.5", "2001:db8::5"]);
    assert.equal(lookup.mock.callCount(), 0);
  });

  it("keeps the resolver's error code when resolve4 and resolve6 both fail", async () => {
    const notFound = () => Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    mock.method(dns, "resolve4", async () => {
      throw notFound();
    });
    mock.method(dns, "resolve6", async () => {
      throw notFound();
    });
    syncBuiltinESMExports();
    await assert.rejects(
      defaultLookup("missing.invalid"),
      (caught: unknown) =>
        caught instanceof CimdError &&
        caught.code === "dns_failed" &&
        caught.message === "DNS resolution failed (ENOTFOUND)",
    );
  });

  it("reports a missing host as dns_failed with its error code, not as unsupported DNS", async () => {
    const notFound = () => Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });
    mock.method(dns, "resolve4", async () => {
      throw notFound();
    });
    mock.method(dns, "resolve6", async () => {
      throw notFound();
    });
    syncBuiltinESMExports();
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => new Response(JSON.stringify(doc)),
    });
    assert.deepEqual(outcome, {
      failure: { code: "dns_failed", detail: "DNS resolution failed (ENOTFOUND)" },
    });
  });
});
