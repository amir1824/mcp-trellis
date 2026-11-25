import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import { buildHandler, capture, json, modern, READ_TOKEN, send } from "../modern/harness.js";
import type { Ctx } from "../ui/harness.js";
import {
  CONCURRENT_READS,
  CONCURRENT_ROWS,
  capturePost,
  makeResourceEnv,
  rpc,
  SECRET_FRAGMENT,
  TOKENS,
  URIS,
} from "./harness.js";

const CACHE_CONTROL = "no-store";

const EVERY_ANSWER = [
  ["a list", "resources/list", undefined, TOKENS.alice],
  ["a read", "resources/read", { uri: URIS.handbook }, TOKENS.alice],
  ["a denied read", "resources/read", { uri: URIS.admin }, TOKENS.alice],
  ["an unknown read", "resources/read", { uri: "docs://nope" }, TOKENS.alice],
  ["an anonymous read", "resources/read", { uri: URIS.open }, undefined],
] as const;

const FAILING: ResourceDef<Ctx> = {
  uri: "docs://failing",
  name: "Failing",
  read: () => {
    throw new Error(SECRET_FRAGMENT);
  },
};

const readText = (reply: { body: { result?: unknown } }): string =>
  (reply.body.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? "";

describe("resources isolation R12 M2", () => {
  it("M2 50 concurrent reads by two tenants each get their own text and the provider runs once per request", async () => {
    const env = makeResourceEnv();
    const replies = await Promise.all(
      CONCURRENT_ROWS.map(({ token }) => rpc(env, "resources/read", { uri: URIS.tenant }, token)),
    );
    assert.deepEqual(
      replies.map(readText),
      CONCURRENT_ROWS.map(({ expected }) => expected),
    );
    assert.equal(env.reads.count, CONCURRENT_READS);
    assert.deepEqual(env.contexts.length, CONCURRENT_READS);
  });

  it("M2 R12 the same principal reading twice runs the provider twice: nothing is memoized", async () => {
    const env = makeResourceEnv();
    await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.alice);
    await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.alice);
    assert.equal(env.reads.count, 2);
  });

  it("R12 a read after another tenant's read still returns its own tenant's text", async () => {
    const env = makeResourceEnv();
    const first = await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.alice);
    const second = await rpc(env, "resources/read", { uri: URIS.tenant }, TOKENS.bob);
    assert.deepEqual([readText(first), readText(second)], ["acme report", "globex report"]);
  });

  for (const [label, method, params, token] of EVERY_ANSWER) {
    it(`R12 ${label} is Cache-Control: no-store`, async () => {
      const response = await capturePost(makeResourceEnv(), method, params, token);
      assert.equal(response.headers["cache-control"], CACHE_CONTROL);
    });
  }

  it("R12 a failed provider answer is Cache-Control: no-store", async () => {
    const env = makeResourceEnv({ resources: [FAILING] });
    const response = await capturePost(env, "resources/read", { uri: FAILING.uri }, TOKENS.alice);
    assert.equal(response.headers["cache-control"], CACHE_CONTROL);
  });

  it("R12 2026-07-28 list and read carry private hints and a zero ttl, never public", async () => {
    const { handler } = buildHandler({
      resources: [{ uri: "docs://m/one", name: "One", scope: "read", read: () => "one" }],
    });
    const list = await json<{ result: Record<string, unknown> }>(
      await send(handler, modern("resources/list", {}, READ_TOKEN)),
    );
    const read = await capture(
      await send(handler, modern("resources/read", { uri: "docs://m/one" }, READ_TOKEN)),
    );
    assert.deepEqual(
      [list.result.cacheScope, list.result.ttlMs, read.headers["cache-control"]],
      ["private", 0, CACHE_CONTROL],
    );
    assert.match(read.body, /"cacheScope":"private"/);
  });
});
