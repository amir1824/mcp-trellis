/** SCRUM-25 T4, R8: the resources example boots, serves each user only what they may read, and keeps its text fallback. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createResourcesDemo } from "../examples/resources-app.js";

const SECRET = "resources-example-secret-with-32-characters!";
const RESOURCE = "https://example.test/mcp";

const { app, auth } = createResourcesDemo(SECRET);

const tokenFor = async (userId: string, scope: string): Promise<string> =>
  (await auth.mintAccessToken({ userId, clientId: "c", scope, resource: RESOURCE })).accessToken;

const rpc = async (token: string, method: string, params?: object) => {
  const response = await app.fetch(
    new Request(RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
    }),
  );
  return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number } };
};

const listedUris = async (token: string): Promise<string[]> => {
  const { result } = await rpc(token, "resources/list");
  const listed = (result?.resources ?? []) as Array<{ uri: string }>;
  return listed.map(({ uri }) => uri);
};

describe("R8 the resources example", () => {
  it("R8 a user with the mcp scope sees the UI document and only the resources they may read", async () => {
    assert.deepEqual(await listedUris(await tokenFor("alice", "mcp")), [
      "ui://shop/products",
      "docs://handbook",
      "docs://tenant/summary",
      "docs://acme/runbook",
    ]);
  });

  it("R8 another user does not see the runbook that allow keeps to the first", async () => {
    assert.deepEqual(await listedUris(await tokenFor("bob", "mcp")), [
      "ui://shop/products",
      "docs://handbook",
      "docs://tenant/summary",
    ]);
  });

  it("R8 the finance scope adds the forecast", async () => {
    const uris = await listedUris(await tokenFor("bob", "mcp finance"));
    assert.ok(uris.includes("docs://finance/forecast"));
  });

  it("R8 each user reads their own tenant's summary", async () => {
    const [alice, bob] = await Promise.all(
      ["alice", "bob"].map(async (user) =>
        rpc(await tokenFor(user, "mcp"), "resources/read", { uri: "docs://tenant/summary" }),
      ),
    );
    assert.deepEqual(
      [alice?.result?.contents, bob?.result?.contents],
      [
        [{ uri: "docs://tenant/summary", mimeType: "text/plain", text: "Summary for acme" }],
        [{ uri: "docs://tenant/summary", mimeType: "text/plain", text: "Summary for globex" }],
      ],
    );
  });

  it("R8 the tool carries its UI and a text fallback for hosts without MCP Apps", async () => {
    const token = await tokenFor("alice", "mcp");
    const listed = await rpc(token, "tools/list");
    const called = await rpc(token, "tools/call", { name: "list_products", arguments: {} });
    assert.deepEqual(
      [
        ((listed.result?.tools ?? []) as Array<{ _meta?: unknown }>)[0]?._meta,
        ((called.result?.content ?? []) as Array<{ text: string }>)[0]?.text,
      ],
      [{ ui: { resourceUri: "ui://shop/products" } }, "2 products for acme"],
    );
  });
});
