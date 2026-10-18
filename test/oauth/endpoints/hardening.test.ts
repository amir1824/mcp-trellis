import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bodyLimitForPath, requestPath } from "../../../src/adapters/node-request.js";
import { DEFAULT_MCP_BODY_LIMIT, DEFAULT_OAUTH_BODY_LIMIT } from "../../../src/http/body.js";
import { readOAuthBody } from "../../../src/oauth/policy/reqbody.js";
import type { OAuthAuditEntry } from "../../../src/oauth/types.js";
import { VALID_S256_CHALLENGE } from "../../helpers/oauth.js";
import { memoryClientStore, stubPorts } from "../../helpers/ports.js";
import { createOAuthRouter } from "../../helpers/router.js";
import { DEFAULT_ORIGIN } from "../../helpers/target.js";

const ORIGIN = DEFAULT_ORIGIN;
const RESOURCE = `${ORIGIN}/mcp`;

describe("a router that does not serve unknown clients", () => {
  it("rejects, at /authorize, a sealed DCR client_id issued by a sibling sharing the codeSecret", async () => {
    const ports = stubPorts();
    const open = createOAuthRouter({ ports });
    const registered = await open.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/register`, {
        method: "POST",
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:9111/cb"] }),
      }),
    );
    assert.ok(registered);
    const { client_id: clientId } = (await registered.json()) as { client_id: string };

    const lockedDown = createOAuthRouter({
      allowUnregisteredClients: false,
      ports: { ...ports, clientStore: memoryClientStore([]) },
    });
    const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://127.0.0.1:9111/cb",
      code_challenge: VALID_S256_CHALLENGE,
      code_challenge_method: "S256",
      resource: RESOURCE,
    }).toString();
    const res = await lockedDown.tryHandle(new Request(url));
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "unauthorized_client");
  });

  it("does not fetch a CIMD document for it", async () => {
    let fetched = false;
    const router = createOAuthRouter({
      allowUnregisteredClients: false,
      cimd: true,
      ports: { ...stubPorts(), clientStore: memoryClientStore([]) },
    });
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("{}");
    }) as typeof fetch;
    try {
      const url = new URL(`${ORIGIN}/mcp/oauth/authorize`);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: "https://client.example/c.json",
        redirect_uri: "http://127.0.0.1:9111/cb",
        code_challenge: VALID_S256_CHALLENGE,
        resource: RESOURCE,
      }).toString();
      const res = await router.tryHandle(new Request(url));
      assert.equal(res?.status, 400);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(fetched, false);
  });
});

describe("refresh grant scope", () => {
  it("rejects a whitespace-only scope instead of handing the port an empty string", async () => {
    let calls = 0;
    const router = createOAuthRouter({
      ports: {
        ...stubPorts(),
        refreshAccessToken: async () => {
          calls += 1;
          return { accessToken: "a", expiresIn: 60 };
        },
      },
    });
    const res = await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "rt",
          client_id: "cid",
          resource: RESOURCE,
          scope: " ",
        }),
      }),
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "invalid_scope");
    assert.equal(calls, 0);
  });
});

describe("readOAuthBody content type", () => {
  const post = (contentType: string, body: string) =>
    new Request(`${ORIGIN}/mcp/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
    });

  it("parses JSON only for the application/json media type, ignoring parameters and case", async () => {
    for (const type of [
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
    ]) {
      assert.deepEqual(await readOAuthBody(post(type, '{"a":"1"}')), { a: "1" }, type);
    }
  });

  it("does not take a text/plain body for JSON because a parameter mentions it", async () => {
    const body = await readOAuthBody(post("text/plain; x=application/json", '{"a":"1"}'));
    assert.deepEqual(body, { '{"a":"1"}': "" });
  });
});

describe("bodyLimitForPath", () => {
  it("applies the OAuth cap to the OAuth path", () => {
    assert.equal(bodyLimitForPath("/mcp/oauth/token"), DEFAULT_OAUTH_BODY_LIMIT);
    assert.equal(bodyLimitForPath("/mcp"), DEFAULT_MCP_BODY_LIMIT);
  });

  it("derives the path the way the router does, so the cap follows the route", () => {
    const limitFor = (url: string) => bodyLimitForPath(requestPath({ url, headers: {} }));
    assert.equal(limitFor("/mcp\\oauth\\token"), DEFAULT_OAUTH_BODY_LIMIT);
    assert.equal(limitFor("/mcp/oauth/token?x=/mcp"), DEFAULT_OAUTH_BODY_LIMIT);
    assert.equal(limitFor("http://evil.test/mcp/oauth/token"), DEFAULT_OAUTH_BODY_LIMIT);
    assert.equal(limitFor("/mcp?next=/oauth"), DEFAULT_MCP_BODY_LIMIT);
  });
});

describe("OAuth audit entries", () => {
  it("bounds a caller-chosen client_id and reason before they reach the sink", async () => {
    const entries: OAuthAuditEntry[] = [];
    const router = createOAuthRouter({
      allowUnregisteredClients: false,
      ports: {
        ...stubPorts(),
        clientStore: memoryClientStore([]),
        audit: (entry) => {
          entries.push(entry);
        },
      },
    });
    await router.tryHandle(
      new Request(`${ORIGIN}/mcp/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "c".repeat(50_000),
        }),
      }),
    );
    assert.ok(entries.length > 0);
    for (const entry of entries) assert.ok((entry.clientId?.length ?? 0) <= 513);
  });
});
