import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { consoleAudit } from "../../../src/audit.js";
import { makeEnv, OPEN_URI, PRODUCTS_URI, readResource, rpc, TOKENS } from "./harness.js";

const MAX_SHOWN = 201;

describe("resources/* audit and parameter handling", () => {
  it("resources/read and resources/list are audited with the method, the resource and the principal", async () => {
    const env = makeEnv();
    await readResource(env, PRODUCTS_URI, TOKENS.alice);
    await rpc(env, "resources/list", undefined, TOKENS.alice);
    await readResource(env, PRODUCTS_URI, TOKENS.eve);
    assert.deepEqual(
      env.audits.map(({ method, resource, principalId, ok, error }) => ({
        method,
        resource,
        principalId,
        ok,
        error,
      })),
      [
        {
          method: "resources/read",
          resource: PRODUCTS_URI,
          principalId: "alice",
          ok: true,
          error: undefined,
        },
        {
          method: "resources/list",
          resource: undefined,
          principalId: "alice",
          ok: true,
          error: undefined,
        },
        {
          method: "resources/read",
          resource: PRODUCTS_URI,
          principalId: "eve",
          ok: false,
          error: "missing_scope",
        },
      ],
    );
  });

  it("an unknown URI is invalid params, and the URI echoed and audited is clipped", async () => {
    const env = makeEnv();
    const reply = await readResource(env, `ui://${"x".repeat(1000)}`, TOKENS.alice);
    assert.equal(reply.body.error?.code, -32602);
    assert.ok((reply.body.error?.message.length ?? 0) <= "Unknown resource: ".length + MAX_SHOWN);
    assert.ok((env.audits[0]?.resource?.length ?? 0) <= MAX_SHOWN);
    assert.equal(env.audits[0]?.error, "unknown_resource");
  });

  it("a missing or non-string uri is invalid params, audited without a resource", async () => {
    const env = makeEnv();
    const missing = await rpc(env, "resources/read", undefined, TOKENS.alice);
    const numeric = await readResource(env, 5, TOKENS.alice);
    const array = await rpc(env, "resources/read", { uri: [OPEN_URI] }, TOKENS.alice);
    assert.equal(missing.body.error?.code, -32602);
    assert.equal(numeric.body.error?.code, -32602);
    assert.equal(array.body.error?.code, -32602);
    assert.deepEqual(
      env.audits.map(({ resource, error }) => ({ resource, error })),
      [
        { resource: undefined, error: "invalid_params" },
        { resource: undefined, error: "invalid_params" },
        { resource: undefined, error: "invalid_params" },
      ],
    );
  });

  it("consoleAudit prints the resource field, quoted and clipped", () => {
    const log = mock.method(console, "log", () => undefined);
    consoleAudit({
      source: "mcp",
      method: "resources/read",
      resource: `ui://a b${"y".repeat(500)}`,
      principalId: "alice",
      ok: true,
      durationMs: 3,
    });
    const line = String(log.mock.calls[0]?.arguments[0]);
    log.mock.restore();
    assert.match(
      line,
      /^\[mcp-trellis\] mcp resources\/read resource="ui:\/\/a by+" ok 3ms user=alice$/,
    );
    assert.ok(line.length < 300);
  });
});
