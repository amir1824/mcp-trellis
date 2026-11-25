import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildHandler,
  type Call,
  json,
  MODERN_VERSION,
  modern,
  modernMeta,
  oversizedBody,
  READ_TOKEN,
  rpc,
  send,
} from "./harness.js";

type ErrorBody = { id: unknown; error: { code: number; message: string; data?: unknown } };

const withoutMeta = (call: Call): Call => ({ ...call, body: rpc("tools/list") });

describe("2026-07-28 request validation", () => {
  it("R5 a request with no _meta is -32602 over HTTP 400", async () => {
    const res = await send(
      buildHandler().handler,
      withoutMeta(modern("tools/list", {}, READ_TOKEN)),
    );
    const body = await json<ErrorBody>(res);
    assert.equal(res.status, 400);
    assert.equal(body.error.code, -32602);
  });

  it("R5 a request with no client capabilities is -32602 over HTTP 400", async () => {
    const call = modern("tools/list", {}, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      body: rpc("tools/list", {
        _meta: { "io.modelcontextprotocol/protocolVersion": MODERN_VERSION },
      }),
    });
    const body = await json<ErrorBody>(res);
    assert.equal(res.status, 400);
    assert.match(body.error.message, /clientCapabilities/);
  });

  it("R5 a _meta version that differs from the header is -32020 over HTTP 400", async () => {
    const call = modern("tools/list", {}, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      body: rpc("tools/list", {
        _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "2025-06-18" },
      }),
    });
    const body = await json<ErrorBody>(res);
    assert.equal(res.status, 400);
    assert.equal(body.error.code, -32020);
  });

  it("R5 a missing Mcp-Method header is -32020", async () => {
    const call = modern("tools/list", {}, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { "MCP-Protocol-Version": MODERN_VERSION },
    });
    assert.equal((await json<ErrorBody>(res)).error.code, -32020);
  });

  it("M4 a header that names tools/list while the body says tools/call never runs the tool", async () => {
    const { handler, toolCalls, audits } = buildHandler();
    const call = modern("tools/call", { name: "echo", arguments: { text: "x" } }, READ_TOKEN);
    const res = await send(handler, {
      ...call,
      headers: { ...call.headers, "Mcp-Method": "tools/list" },
    });
    assert.equal(res.status, 400);
    assert.equal(toolCalls.count, 0);
    assert.deepEqual(audits, []);
  });

  it("M4 an Mcp-Name that differs from the tool in the body never runs the tool", async () => {
    const { handler, toolCalls } = buildHandler();
    const call = modern("tools/call", { name: "echo" }, READ_TOKEN);
    const res = await send(handler, {
      ...call,
      headers: { ...call.headers, "Mcp-Name": "secret_write" },
    });
    assert.equal((await json<ErrorBody>(res)).error.code, -32020);
    assert.equal(toolCalls.count, 0);
  });

  it("M4 a tools/call with no Mcp-Name header never runs the tool", async () => {
    const { handler, toolCalls } = buildHandler();
    const call = modern("tools/call", { name: "echo" }, READ_TOKEN);
    const { "Mcp-Name": _dropped, ...headers } = call.headers ?? {};
    const res = await send(handler, { ...call, headers });
    assert.equal(res.status, 400);
    assert.equal(toolCalls.count, 0);
  });

  it("R2 R20 a non-ASCII Mcp-Name in the base64 form matches the body value", async () => {
    const name = "écho";
    const encoded = `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode(name)))}?=`;
    const call = modern("tools/call", { name }, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { ...call.headers, "Mcp-Name": encoded },
    });
    assert.equal(res.status, 200);
  });

  it("R5 a header in the base64 form that does not decode is -32020", async () => {
    const call = modern("tools/call", { name: "echo" }, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { ...call.headers, "Mcp-Name": "=?base64?%%%?=" },
    });
    assert.equal((await json<ErrorBody>(res)).error.code, -32020);
  });

  it("R5 a modern client asking for a version the server lacks gets -32022 with the supported list", async () => {
    const call = modern("tools/list", {}, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { "MCP-Protocol-Version": "2027-01-01" },
      body: rpc("tools/list", {
        _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": "2027-01-01" },
      }),
    });
    const body = await json<ErrorBody>(res);
    assert.equal(res.status, 400);
    assert.equal(body.error.code, -32022);
    assert.deepEqual(body.error.data, {
      supported: ["2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05"],
      requested: "2027-01-01",
    });
  });

  it("M6 a very long requested version is clipped in the -32022 answer", async () => {
    const long = "9".repeat(5000);
    const call = modern("tools/list");
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { "MCP-Protocol-Version": long },
      body: rpc("tools/list", {
        _meta: { ...modernMeta(), "io.modelcontextprotocol/protocolVersion": long },
      }),
    });
    const body = await json<ErrorBody>(res);
    assert.equal((body.error.data as { requested: string }).requested.length <= 65, true);
  });

  it("M6 error messages repeat no client text", async () => {
    const hostile = "<script>alert(1)</script>";
    const call = modern("tools/call", { name: hostile }, READ_TOKEN);
    const res = await send(buildHandler().handler, {
      ...call,
      headers: { ...call.headers, "Mcp-Name": "other" },
    });
    assert.doesNotMatch(await res.text(), /script/);
  });

  it("M1 an older version header with a modern _meta key and no match is still the older answer", async () => {
    const res = await send(buildHandler().handler, {
      body: rpc("tools/list", { _meta: modernMeta() }),
      headers: { "MCP-Protocol-Version": "1999-01-01" },
      token: READ_TOKEN,
    });
    const body = await json<ErrorBody>(res);
    assert.equal(body.error.code, -32600);
  });

  it("M3 an oversized body under the modern header is -32600 over HTTP 413, never -32002", async () => {
    const res = await send(buildHandler().handler, {
      body: oversizedBody(),
      headers: {
        "MCP-Protocol-Version": MODERN_VERSION,
        "Content-Length": String(oversizedBody().length),
      },
    });
    const body = await json<ErrorBody>(res);
    assert.equal(res.status, 413);
    assert.equal(body.error.code, -32600);
  });

  it("M3 the same oversized body without the header still answers -32002", async () => {
    const res = await send(buildHandler().handler, {
      body: oversizedBody(),
      headers: { "Content-Length": String(oversizedBody().length) },
    });
    assert.equal((await json<ErrorBody>(res)).error.code, -32002);
  });

  it("R14 methods outside the T2 scope are 404 -32601 under the modern header", async () => {
    const { handler } = buildHandler();
    const prompts = await send(handler, modern("prompts/list", {}, READ_TOKEN));
    const listen = await send(handler, modern("subscriptions/listen", {}, READ_TOKEN));
    const templates = await send(handler, modern("resources/templates/list", {}, READ_TOKEN));
    assert.deepEqual([prompts.status, listen.status, templates.status], [404, 404, 404]);
    assert.equal((await json<ErrorBody>(prompts)).error.code, -32601);
  });

  it("R5 initialize and ping need authentication, then answer method not found, under the modern header", async () => {
    const { handler } = buildHandler();
    const anonymous = await send(handler, modern("initialize"));
    const initialize = await send(handler, modern("initialize", {}, READ_TOKEN));
    const ping = await send(handler, modern("ping", {}, READ_TOKEN));
    assert.equal(anonymous.status, 401);
    assert.deepEqual([initialize.status, ping.status], [404, 404]);
    assert.equal((await json<ErrorBody>(initialize)).error.code, -32601);
  });
});
