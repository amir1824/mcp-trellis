/**
 * SCRUM-25 T3, R2 and M2: what CIMD retrieval refuses, what it only detects, and the opt-in rules.
 * A stubbed `fetch` and `lookup` prove the guard logic around them, not a real network or resolver.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type CimdDocument, resolveCimdOutcome } from "../../../src/oauth/cimd/cimd.js";
import { cimdFetchOpts } from "../../../src/oauth/cimd/options.js";

const CLIENT_ID = "https://clients.example/claude.json";
const PUBLIC_ADDRESS = ["203.0.113.10"];
const PRIVATE_ADDRESS = ["10.0.0.5"];

const doc: CimdDocument = {
  client_id: CLIENT_ID,
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
};

const documentResponse = (contentType?: string): Response =>
  new Response(JSON.stringify(doc), {
    status: 200,
    ...(contentType ? { headers: { "Content-Type": contentType } } : {}),
  });

const redirectTo = (location: string): Response =>
  new Response(null, { status: 302, headers: { Location: location } });

const failureCodeOf = async (
  clientId: string,
  options: Parameters<typeof resolveCimdOutcome>[1],
) => {
  const outcome = await resolveCimdOutcome(clientId, options);
  return "failure" in outcome ? outcome.failure.code : "resolved";
};

describe("R2 CIMD retrieval refuses addresses a client_id can be spelled as", () => {
  const SPELLINGS = [
    "https://2130706433/c.json",
    "https://0x7f.1/c.json",
    "https://0177.0.0.1/c.json",
    "https://127.1/c.json",
    "https://169.254.169.254/c.json",
    "https://100.100.100.200/c.json",
    "https://[::ffff:127.0.0.1]/c.json",
    "https://[fd00:ec2::254]/c.json",
    "https://localhost./c.json",
  ];

  it("R2 M2 every spelling of a loopback, link-local or metadata address is refused before any request", async () => {
    const requested: string[] = [];
    const codes = await Promise.all(
      SPELLINGS.map((clientId) =>
        failureCodeOf(clientId, {
          fetch: async (input) => {
            requested.push(String(input));
            return documentResponse();
          },
          lookup: async () => PUBLIC_ADDRESS,
        }),
      ),
    );
    assert.deepEqual(
      codes,
      SPELLINGS.map(() => "blocked_address"),
    );
    assert.deepEqual(requested, []);
  });
});

describe("R2 M2 redirects and resolver answers that change", () => {
  it("R2 M2 a same-origin redirect whose host now resolves to a private address is never requested", async () => {
    const answers = [PUBLIC_ADDRESS, PRIVATE_ADDRESS];
    const responses = [redirectTo("/elsewhere.json"), documentResponse()];
    const requested: string[] = [];
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async (input) => {
        requested.push(String(input));
        return responses.shift() ?? documentResponse();
      },
      lookup: async () => answers.shift() ?? PRIVATE_ADDRESS,
    });
    assert.equal("failure" in outcome && outcome.failure.code, "blocked_address");
    assert.deepEqual(requested, [CLIENT_ID]);
  });

  it("R2 M2 a host fetch that followed a redirect itself is refused", async () => {
    const followed = documentResponse();
    Object.defineProperty(followed, "redirected", { value: true });
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => followed,
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.deepEqual(outcome, {
      failure: { code: "redirect_refused", detail: "fetch followed a redirect" },
    });
  });

  it("R2 M2 an https to http redirect is refused as a cross-origin redirect", async () => {
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => redirectTo("http://clients.example/claude.json"),
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.deepEqual(outcome, {
      failure: { code: "redirect_refused", detail: "cross-origin redirect" },
    });
  });

  it("R2 M2 an answer that flips to a private address after the body is refused, but the request already went out", async () => {
    const answers = [PUBLIC_ADDRESS, PRIVATE_ADDRESS];
    const requested: string[] = [];
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async (input) => {
        requested.push(String(input));
        return documentResponse();
      },
      lookup: async () => answers.shift() ?? PRIVATE_ADDRESS,
    });
    assert.equal("failure" in outcome && outcome.failure.code, "blocked_address");
    assert.deepEqual(requested, [CLIENT_ID]);
  });
});

describe("R2 the opt-in port and Content-Type rules", () => {
  const PORT_CLIENT_ID = "https://clients.example:6379/claude.json";
  const portDocument = { ...doc, client_id: PORT_CLIENT_ID };

  const fetchPortDocument = async () => new Response(JSON.stringify(portDocument));

  it("R2 M5 without cimdAllowedPorts any port is fetched, as before", async () => {
    const outcome = await resolveCimdOutcome(PORT_CLIENT_ID, {
      fetch: fetchPortDocument,
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.deepEqual("doc" in outcome && outcome.doc.client_id, PORT_CLIENT_ID);
  });

  it("R2 with allowedPorts [443] another port is refused before any request", async () => {
    const requested: string[] = [];
    const code = await failureCodeOf(PORT_CLIENT_ID, {
      allowedPorts: [443],
      fetch: async (input) => {
        requested.push(String(input));
        return fetchPortDocument();
      },
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.equal(code, "blocked_url");
    assert.deepEqual(requested, []);
  });

  it("R2 with allowedPorts [443] a URL without a port is on 443 and is fetched", async () => {
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      allowedPorts: [443],
      fetch: async () => documentResponse(),
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.equal("doc" in outcome, true);
  });

  it("R2 M5 without requireJsonContentType a text/plain document is accepted, as before", async () => {
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      fetch: async () => documentResponse("text/plain"),
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.equal("doc" in outcome, true);
  });

  it("R2 with requireJsonContentType a text/plain document is refused as not_json", async () => {
    const code = await failureCodeOf(CLIENT_ID, {
      requireJsonContentType: true,
      fetch: async () => documentResponse("text/plain"),
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.equal(code, "not_json");
  });

  it("R2 with requireJsonContentType a missing Content-Type is refused, and +json and charset forms are accepted", async () => {
    const codes = await Promise.all(
      [undefined, "application/json; charset=utf-8", "application/client+json"].map((type) =>
        failureCodeOf(CLIENT_ID, {
          requireJsonContentType: true,
          fetch: async () => documentResponse(type),
          lookup: async () => PUBLIC_ADDRESS,
        }),
      ),
    );
    assert.deepEqual(codes, ["not_json", "resolved", "resolved"]);
  });
});

describe("R2 R24 the host-facing options reach the fetcher", () => {
  it("R24 cimdFetchOpts carries a host fetch, the port list and the Content-Type rule through", () => {
    const hostFetch: typeof fetch = async () => new Response("");
    const opts = cimdFetchOpts({
      cimdFetch: hostFetch,
      cimdAllowedPorts: [443],
      cimdRequireJsonContentType: true,
    });
    assert.deepEqual(opts, {
      fetch: hostFetch,
      allowedPorts: [443],
      requireJsonContentType: true,
    });
  });

  it("R24 M5 cimdFetchOpts of no options is empty, so nothing changes for an existing host", () => {
    assert.deepEqual(cimdFetchOpts({}), {});
  });

  it("R2 R24 a host-supplied fetch is the one that retrieves the document", async () => {
    const requested: string[] = [];
    const opts = cimdFetchOpts({
      cimdFetch: async (input) => {
        requested.push(String(input));
        return documentResponse();
      },
    });
    await resolveCimdOutcome(CLIENT_ID, { ...opts, lookup: async () => PUBLIC_ADDRESS });
    assert.deepEqual(requested, [CLIENT_ID]);
  });
});

describe("R11 a cached CIMD document keeps its redirect_uris until it expires", () => {
  it("R11 a document changed at the client is not seen while the cached copy is valid", async () => {
    const changed = { ...doc, redirect_uris: ["https://attacker.example/cb"] };
    const outcome = await resolveCimdOutcome(CLIENT_ID, {
      cache: { get: async () => doc, set: async () => undefined },
      fetch: async () => new Response(JSON.stringify(changed)),
      lookup: async () => PUBLIC_ADDRESS,
    });
    assert.deepEqual("doc" in outcome && outcome.doc.redirect_uris, doc.redirect_uris);
  });
});
