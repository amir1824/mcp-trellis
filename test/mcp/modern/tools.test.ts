import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandler, INGEST_TOKEN, json, modern, READ_TOKEN, send } from "./harness.js";

type ListResult = {
  result: {
    resultType: string;
    tools: Array<{ name: string }>;
    ttlMs: number;
    cacheScope: string;
  };
};
type CallResult = {
  result: {
    resultType: string;
    content: Array<{ text: string }>;
    ttlMs?: number;
    cacheScope?: string;
  };
};
type ErrorBody = { error: { code: number } };

const names = (body: ListResult): string[] => body.result.tools.map((tool) => tool.name);

const APPS = { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } };

describe("2026-07-28 tools and resources", () => {
  it("R2 R3 tools/list carries resultType, ttlMs and a private cacheScope", async () => {
    const body = await json<ListResult>(
      await send(buildHandler().handler, modern("tools/list", {}, READ_TOKEN)),
    );
    assert.equal(body.result.resultType, "complete");
    assert.equal(body.result.ttlMs, 0);
    assert.equal(body.result.cacheScope, "private");
  });

  it("R3 R21 M2 two principals with different scopes and tenants each get a private list that matches their own scopes", async () => {
    const { handler } = buildHandler({ hideToolsOutsideScope: true });
    const reader = await json<ListResult>(
      await send(handler, modern("tools/list", {}, READ_TOKEN)),
    );
    const ingester = await json<ListResult>(
      await send(handler, modern("tools/list", {}, INGEST_TOKEN)),
    );
    assert.deepEqual(names(reader), ["echo"]);
    assert.deepEqual(names(ingester), ["echo", "secret_write"]);
    assert.equal(reader.result.cacheScope, "private");
    assert.equal(ingester.result.cacheScope, "private");
  });

  it("M2 the unfiltered tools/list is private too, because it is served only after authentication", async () => {
    const body = await json<ListResult>(
      await send(
        buildHandler({ hideToolsOutsideScope: false }).handler,
        modern("tools/list", {}, READ_TOKEN),
      ),
    );
    assert.equal(body.result.cacheScope, "private");
  });

  it("R3 M2 resources/list and resources/read are private and follow the caller's scopes", async () => {
    const { handler } = buildHandler({ hideToolsOutsideScope: true }, true);
    const list = await json<{
      result: { resources: unknown[]; cacheScope: string; resultType: string };
    }>(await send(handler, modern("resources/list", {}, INGEST_TOKEN, APPS)));
    const read = await json<{ result: { contents: unknown[]; cacheScope: string } }>(
      await send(handler, modern("resources/read", { uri: "ui://test/view" }, INGEST_TOKEN, APPS)),
    );
    const readerList = await json<{ result: { resources: unknown[] } }>(
      await send(handler, modern("resources/list", {}, READ_TOKEN, APPS)),
    );
    const denied = await send(
      handler,
      modern("resources/read", { uri: "ui://test/view" }, READ_TOKEN, APPS),
    );
    assert.equal(list.result.cacheScope, "private");
    assert.equal(list.result.resultType, "complete");
    assert.equal(read.result.cacheScope, "private");
    assert.equal(list.result.resources.length, 1);
    assert.equal(readerList.result.resources.length, 0);
    assert.equal((await json<ErrorBody>(denied)).error.code, -32602);
  });

  it("R2 tools/call carries resultType and no cache hints, because its result is never cacheable", async () => {
    const body = await json<CallResult>(
      await send(
        buildHandler().handler,
        modern("tools/call", { name: "echo", arguments: { text: "hi" } }, READ_TOKEN),
      ),
    );
    assert.equal(body.result.resultType, "complete");
    assert.equal(body.result.content[0]?.text, "hi");
    assert.equal(body.result.ttlMs, undefined);
    assert.equal(body.result.cacheScope, undefined);
  });

  it("R5 a protocol error carries no resultType", async () => {
    const body = await json<Record<string, unknown>>(
      await send(buildHandler().handler, modern("tools/call", { name: "nope" }, READ_TOKEN)),
    );
    assert.equal("result" in body, false);
    assert.equal((body as unknown as ErrorBody).error.code, -32602);
  });

  it("R13 a modern tools/call without a token is 401 with the same challenge as before", async () => {
    const res = await send(buildHandler().handler, modern("tools/call", { name: "echo" }));
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  it("R13 a modern tools/call without the tool's scope is 403 insufficient_scope", async () => {
    const { handler, toolCalls } = buildHandler();
    const res = await send(handler, modern("tools/call", { name: "secret_write" }, READ_TOKEN));
    assert.equal(res.status, 403);
    assert.match(res.headers.get("www-authenticate") ?? "", /insufficient_scope/);
    assert.equal(toolCalls.count, 0);
  });

  it("R13 a modern tools/list without a token is 401", async () => {
    assert.equal((await send(buildHandler().handler, modern("tools/list"))).status, 401);
  });
});
