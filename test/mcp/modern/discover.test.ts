import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildHandler, json, modern, READ_TOKEN, send } from "./harness.js";

type Discover = {
  id: number;
  result: {
    resultType: string;
    supportedVersions: string[];
    capabilities: Record<string, unknown>;
    _meta: Record<string, { name: string; version: string }>;
    instructions: string;
    ttlMs: number;
    cacheScope: string;
  };
};

describe("server/discover", () => {
  it("R1 R2 answers an anonymous discover with versions, capabilities and server info", async () => {
    const res = await send(buildHandler().handler, modern("server/discover"));
    const body = await json<Discover>(res);
    assert.equal(res.status, 200);
    assert.equal(body.result.resultType, "complete");
    assert.deepEqual(body.result.supportedVersions, [
      "2026-07-28",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);
    assert.deepEqual(body.result.capabilities, { tools: {} });
    assert.deepEqual(body.result._meta["io.modelcontextprotocol/serverInfo"], {
      name: "test",
      version: "0.0.1",
    });
    assert.equal(body.result.instructions, "test server");
  });

  it("R3 an anonymous discover is public, because anyone may read it", async () => {
    const body = await json<Discover>(
      await send(buildHandler().handler, modern("server/discover")),
    );
    assert.equal(body.result.cacheScope, "public");
    assert.equal(body.result.ttlMs, 0);
  });

  it("R3 M2 M5 a host that requires authentication for discover gets 401 anonymously and private when authenticated", async () => {
    const { handler } = buildHandler({ publicMethods: new Set(["initialize"]) });
    const anonymous = await send(handler, modern("server/discover"));
    const authenticated = await json<Discover>(
      await send(handler, modern("server/discover", {}, READ_TOKEN)),
    );
    assert.equal(anonymous.status, 401);
    assert.equal(authenticated.result.cacheScope, "private");
  });

  it("M5 a host that listed discover itself serves it anonymously", async () => {
    const { handler } = buildHandler({ publicMethods: new Set(["server/discover"]) });
    assert.equal((await send(handler, modern("server/discover"))).status, 200);
  });

  it("M5 initialize and ping are never anonymous under the modern header, even if the host listed them", async () => {
    const { handler } = buildHandler({ publicMethods: new Set(["initialize", "ping"]) });
    const initialize = await send(handler, modern("initialize"));
    const ping = await send(handler, modern("ping"));
    assert.equal(initialize.status, 401);
    assert.equal(ping.status, 401);
  });

  it("R10 a handler built with the same minimal options as before serves discover", async () => {
    const res = await send(buildHandler().handler, modern("server/discover"));
    assert.equal(res.status, 200);
  });

  it("R2 a server with a UI advertises resources and the Apps extension", async () => {
    const body = await json<Discover>(
      await send(buildHandler({}, true).handler, modern("server/discover")),
    );
    assert.deepEqual(body.result.capabilities, {
      tools: {},
      resources: {},
      extensions: { "io.modelcontextprotocol/ui": {} },
    });
  });
});
