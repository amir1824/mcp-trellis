import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRODUCTS_URI } from "../ui/harness.js";
import { listedUris, makeResourceEnv, type ResourceEnv, rpc, TOKENS, URIS } from "./harness.js";

type Action = (env: ResourceEnv) => Promise<unknown>;

const read = (uri: unknown, token?: string): Action => {
  return (env) => rpc(env, "resources/read", { uri }, token);
};

const NEVER_BUILDS_CONTEXT: ReadonlyArray<[string, Action]> = [
  ["a list", (env) => listedUris(env, TOKENS.alice)],
  ["an anonymous list", (env) => rpc(env, "resources/list")],
  ["an anonymous read", read(URIS.open)],
  ["a read with a non-string uri", read(7, TOKENS.alice)],
  ["a read with no params", (env) => rpc(env, "resources/read", undefined, TOKENS.alice)],
  ["an unknown uri", read("docs://nope", TOKENS.alice)],
  ["a read denied by scope", read(URIS.admin, TOKENS.alice)],
  ["a read denied by allow", read(URIS.acmeOnly, TOKENS.bob)],
  ["a read whose allow throws", read(URIS.broken, TOKENS.alice)],
  ["a ui:// read", read(PRODUCTS_URI, TOKENS.alice)],
  ["a denied ui:// read", read("ui://shop/admin", TOKENS.alice)],
];

const PUBLIC_RESOURCE_METHODS = { publicMethods: new Set(["resources/list", "resources/read"]) };

const ANONYMOUS_PUBLIC_CALLS = [
  ["resources/list", undefined],
  ["resources/read", { uri: URIS.open }],
] as const;

describe("resources context R4 M5", () => {
  for (const [label, action] of NEVER_BUILDS_CONTEXT) {
    it(`M5 ${label} never builds the context`, async () => {
      const env = makeResourceEnv({ withUi: true });
      await action(env);
      assert.deepEqual(env.contexts, []);
    });
  }

  for (const [method, params] of ANONYMOUS_PUBLIC_CALLS) {
    it(`M5 an anonymous ${method} listed in publicMethods never builds the context`, async () => {
      const env = makeResourceEnv({ options: PUBLIC_RESOURCE_METHODS });
      await rpc(env, method, params);
      assert.deepEqual(env.contexts, []);
    });
  }

  it("R4 M5 an authorized general read builds the context once, for that principal, and runs the provider", async () => {
    const env = makeResourceEnv();
    const reply = await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.alice);
    assert.deepEqual(env.contexts, ["alice"]);
    assert.equal(env.reads.count, 1);
    assert.deepEqual(reply.body.result, {
      contents: [{ uri: URIS.tenant, mimeType: "text/plain", text: "acme report" }],
    });
  });

  it("R4 a context port that throws answers 500 and the provider never runs", async () => {
    const env = makeResourceEnv({
      options: {
        ports: {
          authenticate: async () => ({ id: "alice", scopes: ["read"] }),
          context: () => {
            throw new Error("context down");
          },
        },
      },
    });
    const reply = await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.alice);
    assert.equal(reply.status, 500);
    assert.equal(env.reads.count, 0);
  });
});
