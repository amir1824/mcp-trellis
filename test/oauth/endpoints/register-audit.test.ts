import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OAuthAuditEntry } from "../../../src/oauth/types.js";
import { stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const register = async (body: string) => {
  const audits: OAuthAuditEntry[] = [];
  const router = createOAuthRouter({
    allowUnregisteredClients: true,
    ports: stubPorts({ audit: (entry) => void audits.push(entry) }),
  });
  const response = await router.tryHandle(
    new Request(`${DEFAULT_ORIGIN}/mcp/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
  return { status: response?.status, audits };
};

/** What the audit entry lists for one refused redirect URI. */
const listed = async (uri: string): Promise<string | undefined> => {
  const { audits } = await register(JSON.stringify({ redirect_uris: [uri] }));
  return audits[0]?.reason.replace("no allowed redirect_uris: ", "");
};

describe("auditing a refused registration", () => {
  it("names the refused redirect URIs without userinfo, query or fragment", async () => {
    const redirectUris = ["https://user:pw@other.test/cb?token=s3cret#frag"];

    const { status, audits } = await register(JSON.stringify({ redirect_uris: redirectUris }));

    assert.equal(status, 400);
    assert.deepEqual(audits, [
      { event: "register_rejected", reason: "no allowed redirect_uris: https://other.test/cb" },
    ]);
  });

  it("strips userinfo written with a single slash", async () => {
    assert.equal(await listed("https:/user:pw@other.test/cb"), "https://other.test/cb");
  });

  it("strips userinfo written with backslashes", async () => {
    assert.equal(await listed("https:\\\\user:pw@other.test/cb"), "https://other.test/cb");
  });

  it("strips userinfo written with no slashes", async () => {
    assert.equal(await listed("https:user:pw@other.test/cb"), "https://other.test/cb");
  });

  it("lists no part of a URI the parser cannot read", async () => {
    assert.equal(await listed("https://user:p?w@other.test/cb"), "[unreadable URI]");
  });

  it("lists no part of a URI whose password reads as a port and a path", async () => {
    assert.equal(await listed("https://user:12/34@other.test/cb"), "[unreadable URI]");
  });

  it("lists no part of a URI whose password reads as a port and a query", async () => {
    assert.equal(await listed("https://user:12?w@other.test/cb"), "[unreadable URI]");
  });

  it("lists no part of a custom scheme URI that holds an @", async () => {
    assert.equal(await listed("myapp:user:pw@other.test"), "[unreadable URI]");
  });

  it("lists a lookalike host in punycode, so it does not read as the real one", async () => {
    const cyrillicA = "\u0430";

    assert.equal(
      await listed(`https://cl${cyrillicA}ude.ai/api/mcp/auth_callback`),
      "https://xn--clude-5ve.ai/api/mcp/auth_callback",
    );
  });

  it("encodes a lookalike host of a custom scheme", async () => {
    assert.equal(await listed("myapp://cl\u0430ude.ai/cb"), "myapp://cl%D0%B0ude.ai/cb");
  });

  it("keeps a URI with nothing to strip exactly as asked", async () => {
    assert.equal(await listed("https://Other.test:443"), "https://Other.test:443");
  });

  it("lists no part of a URI whose dot segment would hide the @", async () => {
    assert.equal(await listed("https://alice:4321/s3cr@other.test/.."), "[unreadable URI]");
  });

  it("lists a URI holding a space as one entry, with the space encoded", async () => {
    const entry = "https://evil.test/x https://good.test/cb";

    assert.equal(await listed(entry), "https://evil.test/x%20https://good.test/cb");
  });

  it("strips userinfo that holds a space", async () => {
    assert.equal(await listed("https://user:p w@other.test/cb"), "https://other.test/cb");
  });

  it("lists no part of a URI holding a line break", async () => {
    assert.equal(await listed("https://other.test/cb\nverified"), "[unreadable URI]");
  });

  it("shortens a long URI so that the next one is still listed", async () => {
    const long = `https://long.test/${"a".repeat(600)}`;

    const { audits } = await register(
      JSON.stringify({ redirect_uris: [long, "https://second.test/cb"] }),
    );

    assert.equal(
      audits[0]?.reason,
      `no allowed redirect_uris: ${long.slice(0, 200)}… https://second.test/cb`,
    );
  });

  it("records a body over the size limit", async () => {
    const { status, audits } = await register("x".repeat(65_537));

    assert.equal(status, 413);
    assert.deepEqual(audits, [{ event: "register_rejected", reason: "request body too large" }]);
  });

  it("lists no more entries than a registration may hold", async () => {
    const redirectUris = [..."abcdefghij", "eleventh"];

    const { audits } = await register(JSON.stringify({ redirect_uris: redirectUris }));

    assert.equal(
      audits[0]?.reason,
      "redirect_uris must have at most 10 entries: a b c d e f g h i j",
    );
  });

  it("records a body that is not a JSON object", async () => {
    const { audits } = await register("not json");

    assert.deepEqual(audits, [
      { event: "register_rejected", reason: "request body must be a JSON object" },
    ]);
  });

  it("lists nothing when no entry is a string", async () => {
    const entry = { toString: 1, valueOf: 1 };

    const { audits } = await register(JSON.stringify({ redirect_uris: [entry] }));

    assert.deepEqual(audits, [{ event: "register_rejected", reason: "no allowed redirect_uris" }]);
  });

  it("records nothing for a registration it accepts", async () => {
    const { status, audits } = await register(
      JSON.stringify({ redirect_uris: ["http://127.0.0.1:4321/cb"] }),
    );

    assert.equal(status, 201);
    assert.deepEqual(audits, []);
  });
});
