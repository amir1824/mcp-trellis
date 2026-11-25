import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeResourceEnv, type ResourceEnv, rpc, TOKENS, URIS } from "./harness.js";

const MAX_SHOWN_URI = 200;
const LONG_URI = `docs://${"x".repeat(MAX_SHOWN_URI + 50)}`;

type Row = {
  label: string;
  run: (env: ResourceEnv) => Promise<unknown>;
  expected: {
    method: string;
    resource?: string;
    principalId?: string;
    ok: boolean;
    error?: string;
  };
};

const ROWS: Row[] = [
  {
    label: "a list",
    run: (env) => rpc(env, "resources/list", undefined, TOKENS.alice),
    expected: { method: "resources/list", principalId: "alice", ok: true },
  },
  {
    label: "a general read",
    run: (env) => rpc(env, "resources/read", { uri: URIS.handbook }, TOKENS.alice),
    expected: { method: "resources/read", resource: URIS.handbook, principalId: "alice", ok: true },
  },
  {
    label: "an unknown uri",
    run: (env) => rpc(env, "resources/read", { uri: "docs://nope" }, TOKENS.alice),
    expected: {
      method: "resources/read",
      resource: "docs://nope",
      principalId: "alice",
      ok: false,
      error: "unknown_resource",
    },
  },
  {
    label: "a read without the scope",
    run: (env) => rpc(env, "resources/read", { uri: URIS.admin }, TOKENS.alice),
    expected: {
      method: "resources/read",
      resource: URIS.admin,
      principalId: "alice",
      ok: false,
      error: "missing_scope",
    },
  },
  {
    label: "a read a false allow denies",
    run: (env) => rpc(env, "resources/read", { uri: URIS.acmeOnly }, TOKENS.bob),
    expected: {
      method: "resources/read",
      resource: URIS.acmeOnly,
      principalId: "bob",
      ok: false,
      error: "rule_denied",
    },
  },
  {
    label: "a read with a non-string uri",
    run: (env) => rpc(env, "resources/read", { uri: 7 }, TOKENS.alice),
    expected: {
      method: "resources/read",
      principalId: "alice",
      ok: false,
      error: "invalid_params",
    },
  },
  {
    label: "a read whose allow throws",
    run: (env) => rpc(env, "resources/read", { uri: URIS.broken }, TOKENS.root),
    expected: {
      method: "resources/read",
      resource: URIS.broken,
      principalId: "root",
      ok: false,
      error: "rule_failed",
    },
  },
  {
    label: "a very long uri",
    run: (env) => rpc(env, "resources/read", { uri: LONG_URI }, TOKENS.alice),
    expected: {
      method: "resources/read",
      resource: `${LONG_URI.slice(0, MAX_SHOWN_URI)}…`,
      principalId: "alice",
      ok: false,
      error: "unknown_resource",
    },
  },
];

describe("resources audit R4", () => {
  for (const { label, run, expected } of ROWS) {
    it(`R4 ${label} leaves exactly one audit entry`, async () => {
      const env = makeResourceEnv();
      await run(env);
      assert.deepEqual(
        env.audits.map(({ method, resource, principalId, ok, error }) => ({
          method,
          resource,
          principalId,
          ok,
          error,
        })),
        [{ resource: undefined, principalId: undefined, error: undefined, ...expected }],
      );
    });
  }

  it("R4 an audit entry carries a numeric duration", async () => {
    const env = makeResourceEnv();
    await rpc(env, "resources/read", { uri: URIS.handbook }, TOKENS.alice);
    assert.equal(typeof env.audits[0]?.durationMs, "number");
  });

  it("R4 an anonymous request is audited as unauthorized", async () => {
    const env = makeResourceEnv({ options: { publicMethods: new Set(["resources/read"]) } });
    await rpc(env, "resources/read", { uri: URIS.open });
    assert.deepEqual(
      env.audits.map(({ method, ok, error, principalId }) => ({ method, ok, error, principalId })),
      [{ method: "resources/read", ok: false, error: "unauthorized", principalId: undefined }],
    );
  });

  it("R4 a failing provider is audited as resource_failed and a successful read is not", async () => {
    const env = makeResourceEnv({
      resources: [{ uri: "docs://boom", name: "Boom", read: () => Promise.reject(new Error("x")) }],
    });
    await rpc(env, "resources/read", { uri: "docs://boom" }, TOKENS.alice);
    assert.deepEqual(
      env.audits.map(({ ok, error }) => ({ ok, error })),
      [{ ok: false, error: "resource_failed" }],
    );
  });
});
