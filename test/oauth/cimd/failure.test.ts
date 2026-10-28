/**
 * Why a CIMD document did not resolve: every failure carries a code the
 * operator's audit sink sees, while the connector keeps one generic error.
 */

import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, describe, it, mock } from "node:test";
import { resolveCimdOutcome } from "../../../src/oauth/cimd/cimd.js";
import { defaultLookup } from "../../../src/oauth/cimd/cimd-ssrf.js";
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

describe("defaultLookup on a runtime without dns.lookup", () => {
  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  it("falls back to resolve4/resolve6 when lookup is not implemented", async () => {
    mock.method(dns, "lookup", async () => {
      throw new Error("Not implemented");
    });
    mock.method(dns, "resolve4", async () => ["203.0.113.5"]);
    mock.method(dns, "resolve6", async () => ["2001:db8::5"]);
    syncBuiltinESMExports();
    assert.deepEqual(await defaultLookup("clients.example"), ["203.0.113.5", "2001:db8::5"]);
  });

  it("reports a missing host as dns_failed with its error code, not as unsupported DNS", async () => {
    mock.method(dns, "lookup", async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    syncBuiltinESMExports();
    await assert.rejects(
      defaultLookup("missing.invalid"),
      (caught: unknown) =>
        caught instanceof CimdError &&
        caught.code === "dns_failed" &&
        caught.message === "DNS lookup failed (ENOTFOUND)",
    );
  });
});
