/**
 * SCRUM-25 T3, R2 R19 R24 and M5: the CIMD options a host passes to `createMcpApp` reach `/authorize`.
 * `cimdFetchOpts` and `resolveCimdOutcome` are tested on their own in `test/oauth/cimd/`; this is the
 * glue between them (`CIMD_PORT_KEYS` in `src/app.ts`) and a request, with a stubbed fetch and resolver.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../src/app.js";
import type { McpAppOptions } from "../../src/app-options.js";
import { signedTokenAuth } from "../../src/auth/signed/token.js";
import { HARNESS_CODE_SECRET } from "../helpers/ports.js";

const CLIENT_ID = "https://clients.example:6379/claude.json";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

type CimdOptions = Pick<McpAppOptions<unknown>, "cimdAllowedPorts" | "cimdRequireJsonContentType">;

/** What `/authorize` answers for a CIMD `client_id`, and how many times the host's fetch was used. */
const authorizeWith = async (options: CimdOptions, contentType: string) => {
  const fetched: string[] = [];
  const auth = signedTokenAuth({
    secret: HARNESS_CODE_SECRET,
    resolveUser: async () => null,
    loginUrl: () => "/login",
  });
  const app = createMcpApp({
    serverInfo: { name: "t", version: "1" },
    auth: { ...auth },
    allowInMemoryCodeStore: true,
    tools: [],
    cimd: true,
    cimdLookup: async () => ["203.0.113.10"],
    cimdFetch: async (input) => {
      fetched.push(String(input));
      return new Response(
        JSON.stringify({
          client_id: CLIENT_ID,
          redirect_uris: [CALLBACK],
          token_endpoint_auth_method: "none",
        }),
        { headers: { "Content-Type": contentType } },
      );
    },
    ...options,
  });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    resource: "https://example.test/mcp",
    state: "s",
  });
  const res = await app.fetch(new Request(`https://example.test/mcp/oauth/authorize?${query}`));
  return { status: res.status, fetched: fetched.length };
};

describe("R2 R19 R24 the CIMD options reach /authorize through createMcpApp", () => {
  it("R2 R24 M5 with none of them set, the host's fetch resolves the document and the user is sent to log in", async () => {
    assert.deepEqual(await authorizeWith({}, "text/plain"), { status: 302, fetched: 1 });
  });

  it("R2 R24 cimdAllowedPorts refuses a port that is not listed before the host's fetch is used", async () => {
    assert.deepEqual(await authorizeWith({ cimdAllowedPorts: [443] }, "text/plain"), {
      status: 400,
      fetched: 0,
    });
  });

  it("R2 R24 cimdRequireJsonContentType refuses a document served as text/plain", async () => {
    assert.deepEqual(await authorizeWith({ cimdRequireJsonContentType: true }, "text/plain"), {
      status: 400,
      fetched: 1,
    });
  });

  it("R2 R24 cimdRequireJsonContentType accepts the same document served as JSON", async () => {
    assert.deepEqual(
      await authorizeWith({ cimdRequireJsonContentType: true }, "application/json"),
      { status: 302, fetched: 1 },
    );
  });
});
