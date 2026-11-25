import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDef } from "../../../src/mcp/registry.js";
import {
  ADMIN_URI,
  CSP,
  type Ctx,
  callTool,
  makeEnv,
  OPEN_URI,
  PRODUCTS_HTML,
  PRODUCTS_URI,
  readResource,
  rpc,
  TOKENS,
} from "./harness.js";

const INIT = { protocolVersion: "2025-06-18" };

/** Tools of a server that never heard of MCP Apps. */
const PLAIN_TOOLS: ToolDef<Ctx>[] = [
  {
    name: "echo",
    description: "echo args",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    scope: "read",
    handler: (_ctx, args) => String(args.text),
  },
  {
    name: "ping_open",
    description: "open tool",
    inputSchema: { type: "object", properties: {} },
    scope: null,
    handler: () => "pong",
  },
];

// The literals below were captured from the code before the MCP Apps change, with the same
// tools, serverInfo and instructions, so they pin what existing servers answered before it.
const BEFORE_INITIALIZE =
  '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"0.0.1"},"instructions":"test server"}}';
const BEFORE_TOOLS_LIST =
  '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"echo","description":"echo args","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}},{"name":"ping_open","description":"open tool","inputSchema":{"type":"object","properties":{}}}]}}';
const BEFORE_NO_RESOURCES_LIST =
  '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: resources/list"}}';
const BEFORE_NO_RESOURCES_READ =
  '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: resources/read"}}';

const plainEnv = () => makeEnv({ tools: PLAIN_TOOLS, resources: null });

describe("R1 servers without UI", () => {
  it("R1 initialize is byte-identical to the output before MCP Apps", async () => {
    const reply = await rpc(plainEnv(), "initialize", INIT);
    assert.equal(reply.text, BEFORE_INITIALIZE);
  });

  it("R1 tools/list is byte-identical to the output before MCP Apps", async () => {
    const reply = await rpc(plainEnv(), "tools/list", undefined, TOKENS.alice);
    assert.equal(reply.text, BEFORE_TOOLS_LIST);
  });

  it("R1 existing tool implementations run unchanged: a string, a text result and an error result", async () => {
    const tools: ToolDef<Ctx>[] = [
      { name: "str", description: "d", inputSchema: { type: "object" }, handler: () => "hi" },
      {
        name: "blocks",
        description: "d",
        inputSchema: { type: "object" },
        handler: () => ({ content: [{ type: "text", text: "a" }] }),
      },
      {
        name: "bad",
        description: "d",
        inputSchema: { type: "object" },
        handler: () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
      },
    ];
    const env = makeEnv({ tools, resources: null });
    const token = TOKENS.alice;
    assert.deepEqual((await callTool(env, "str", token)).body.result, {
      content: [{ type: "text", text: "hi" }],
      isError: false,
    });
    assert.deepEqual((await callTool(env, "blocks", token)).body.result, {
      content: [{ type: "text", text: "a" }],
    });
    assert.deepEqual((await callTool(env, "bad", token)).body.result, {
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
  });
});

describe("R2 UI metadata and resources", () => {
  it("R2 tools/list carries the nested _meta.ui and no flat ui/resourceUri key", async () => {
    const reply = await rpc(makeEnv(), "tools/list", undefined, TOKENS.alice);
    const { tools } = reply.body.result as { tools: Array<Record<string, unknown>> };
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    assert.deepEqual(byName.list_products?._meta, {
      ui: { resourceUri: PRODUCTS_URI, visibility: ["model", "app"] },
    });
    assert.deepEqual(byName.refresh_products?._meta, {
      ui: { resourceUri: PRODUCTS_URI, visibility: ["app"] },
    });
    assert.deepEqual(byName.open_widget?._meta, { ui: { resourceUri: OPEN_URI } });
    assert.equal("_meta" in (byName.plain_tool ?? {}), false);
    assert.doesNotMatch(reply.text, /ui\/resourceUri/);
  });

  it("R2 resources/read returns the matching html with the MCP Apps mime type and its csp", async () => {
    const reply = await readResource(makeEnv(), PRODUCTS_URI, TOKENS.alice);
    assert.deepEqual(reply.body.result, {
      contents: [
        {
          uri: PRODUCTS_URI,
          mimeType: "text/html;profile=mcp-app",
          text: PRODUCTS_HTML,
          _meta: { ui: { csp: CSP } },
        },
      ],
    });
  });

  it("R2 a resource without csp carries no _meta, so the host applies its restrictive default", async () => {
    const reply = await readResource(makeEnv(), OPEN_URI, TOKENS.alice);
    assert.deepEqual(reply.body.result, {
      contents: [
        { uri: OPEN_URI, mimeType: "text/html;profile=mcp-app", text: "<html>open</html>" },
      ],
    });
  });

  it("R2 resources/list names each resource the principal may read, with the MCP Apps mime type", async () => {
    const reply = await rpc(makeEnv(), "resources/list", undefined, TOKENS.alice);
    assert.deepEqual(reply.body.result, {
      resources: [
        {
          uri: PRODUCTS_URI,
          name: "Products",
          description: "Product cards",
          mimeType: "text/html;profile=mcp-app",
        },
        { uri: OPEN_URI, name: OPEN_URI, mimeType: "text/html;profile=mcp-app" },
      ],
    });
  });
});

describe("R5 hosts without MCP Apps", () => {
  it("R5 a UI tool's result keeps a text block next to structuredContent", async () => {
    const reply = await callTool(makeEnv(), "list_products", TOKENS.alice);
    assert.deepEqual(reply.body.result, {
      content: [{ type: "text", text: "acme has 2 products" }],
      structuredContent: { tenant: "acme", userId: "alice", items: ["a", "b"] },
    });
  });

  it("R5 a UI tool that returns a plain string still answers with a text block", async () => {
    const reply = await callTool(makeEnv(), "open_widget", TOKENS.eve);
    assert.deepEqual(reply.body.result, {
      content: [{ type: "text", text: "open" }],
      isError: false,
    });
  });
});

describe("M6 servers without UI stay as they were", () => {
  it("M6 resources/list and resources/read answer method-not-found, byte-identical, and initialize declares no resources", async () => {
    const env = plainEnv();
    const list = await rpc(env, "resources/list", undefined, TOKENS.alice);
    const read = await readResource(env, PRODUCTS_URI, TOKENS.alice);
    const init = await rpc(env, "initialize", INIT);
    assert.equal(list.text, BEFORE_NO_RESOURCES_LIST);
    assert.equal(read.text, BEFORE_NO_RESOURCES_READ);
    assert.doesNotMatch(init.text, /resources/);
  });

  it("M6 the same server with a UI declares resources and answers them", async () => {
    const env = makeEnv();
    const init = await rpc(env, "initialize", INIT);
    const list = await rpc(env, "resources/list", undefined, TOKENS.root);
    assert.deepEqual((init.body.result as { capabilities: unknown }).capabilities, {
      tools: {},
      resources: {},
    });
    assert.equal(list.status, 200);
    assert.equal((list.body.result as { resources: unknown[] }).resources.length, 3);
  });
});

describe("M7 resource URIs are never object keys", () => {
  it("M7 __proto__, constructor and toString are unknown resources", async () => {
    const env = makeEnv();
    const token = TOKENS.root;
    assert.equal((await readResource(env, "__proto__", token)).body.error?.code, -32602);
    assert.equal((await readResource(env, "constructor", token)).body.error?.code, -32602);
    assert.equal((await readResource(env, "toString", token)).body.error?.code, -32602);
    assert.equal((await readResource(env, "ui://__proto__", token)).body.error?.code, -32602);
  });

  it("M7 a registered URI resolves", async () => {
    const reply = await readResource(makeEnv(), ADMIN_URI, TOKENS.root);
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.result, {
      contents: [
        { uri: ADMIN_URI, mimeType: "text/html;profile=mcp-app", text: "<html>admin</html>" },
      ],
    });
  });
});

describe("M8 tool results are checked before they reach the client", () => {
  const INVALID = {
    content: [{ type: "text", text: "Tool returned an invalid result" }],
    isError: true,
  };
  const returning = (name: string, result: unknown): ToolDef<Ctx> => ({
    name,
    description: "d",
    inputSchema: { type: "object" },
    handler: () => result as never,
  });
  const text = [{ type: "text", text: "ok" }];

  it("M8 a non-object structuredContent never reaches the client", async () => {
    const env = makeEnv({
      resources: null,
      tools: [
        returning("as_string", { content: text, structuredContent: "x" }),
        returning("as_array", { content: text, structuredContent: [1] }),
        returning("as_null", { content: text, structuredContent: null }),
        returning("bad_meta", { content: text, _meta: "x" }),
      ],
    });
    const token = TOKENS.alice;
    assert.deepEqual((await callTool(env, "as_string", token)).body.result, INVALID);
    assert.deepEqual((await callTool(env, "as_array", token)).body.result, INVALID);
    assert.deepEqual((await callTool(env, "as_null", token)).body.result, INVALID);
    assert.deepEqual((await callTool(env, "bad_meta", token)).body.result, INVALID);
  });

  it("M8 an error result whose text is not a string is returned as the tool's result, not a 500", async () => {
    const env = makeEnv({
      resources: null,
      tools: [returning("bad_text", { content: [{ type: "text", text: 5 }], isError: true })],
    });
    const reply = await callTool(env, "bad_text", TOKENS.alice);
    assert.equal(reply.status, 200);
    assert.equal(env.audits[0]?.ok, false);
    assert.equal(env.audits[0]?.error, undefined);
  });

  it("M8 a non-array content never reaches the client", async () => {
    const env = makeEnv({
      resources: null,
      tools: [
        returning("as_string", { content: "text" }),
        returning("as_object", { content: { type: "text", text: "x" } }),
        returning("missing", { structuredContent: { a: 1 } }),
      ],
    });
    const token = TOKENS.alice;
    assert.deepEqual((await callTool(env, "as_string", token)).body.result, INVALID);
    assert.deepEqual((await callTool(env, "as_object", token)).body.result, INVALID);
    assert.deepEqual((await callTool(env, "missing", token)).body.result, INVALID);
  });

  it("M8 a valid result with content blocks, structuredContent and _meta passes unchanged", async () => {
    const valid = {
      content: [
        { type: "text", text: "see chart" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource_link", uri: "https://example.test/a", name: "a" },
      ],
      structuredContent: { rows: [1, 2] },
      _meta: { trace: "t1" },
    };
    const env = makeEnv({ resources: null, tools: [returning("ok", valid)] });
    assert.deepEqual((await callTool(env, "ok", TOKENS.alice)).body.result, valid);
  });
});
