import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { asNodeHandler } from "../../../src/adapters/node.js";
import { createMcpHandler } from "../../../src/mcp/dispatch.js";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import { buildParamHandler, modernWith, PARAM_SCHEMA } from "./harness.js";

const BASE_ALLOWED = "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name";

const preflight = (handler: ReturnType<typeof createMcpHandler>) =>
  handler.fetch(new Request("https://example.test/mcp", { method: "OPTIONS" }));

const handlerFor = (scope: string | undefined, hide: boolean) =>
  createMcpHandler<object>({
    registry: createToolRegistry<object>([
      {
        name: "annotated",
        description: "d",
        inputSchema: PARAM_SCHEMA,
        scope,
        handler: () => "ok",
      },
    ]),
    serverInfo: { name: "t", version: "1" },
    wwwAuthenticate: { realm: "t", resourceMetadataUrl: "https://example.test/x" },
    hideToolsOutsideScope: hide,
    ports: { authenticate: async () => ({ id: "u", scopes: ["*"] }), context: async () => ({}) },
  });

describe("CORS preflight for Mcp-Param-* headers", () => {
  it("adds exactly the registered names after the standard ones", async () => {
    const allowed = (await preflight(buildParamHandler().handler)).headers.get(
      "Access-Control-Allow-Headers",
    );
    assert.equal(
      allowed,
      `${BASE_ALLOWED}, Mcp-Param-Region, Mcp-Param-Count, Mcp-Param-Flag, Mcp-Param-Zone`,
    );
  });

  it("a server with no annotated tool answers the unchanged list", async () => {
    const handler = createMcpHandler<object>({
      registry: createToolRegistry<object>([
        { name: "p", description: "d", inputSchema: { type: "object" }, handler: () => "" },
      ]),
      serverInfo: { name: "t", version: "1" },
      wwwAuthenticate: { realm: "t", resourceMetadataUrl: "https://example.test/x" },
      ports: { authenticate: async () => null, context: async () => ({}) },
    });
    assert.equal(
      (await preflight(handler)).headers.get("Access-Control-Allow-Headers"),
      BASE_ALLOWED,
    );
  });

  it("names from a scoped tool are listed when tools/list shows it to everyone", async () => {
    const allowed = (await preflight(handlerFor("admin", false))).headers.get(
      "Access-Control-Allow-Headers",
    );
    assert.match(allowed ?? "", /Mcp-Param-Region/);
  });

  it("names from a scoped tool are left out when hideToolsOutsideScope hides it", async () => {
    const allowed = (await preflight(handlerFor("admin", true))).headers.get(
      "Access-Control-Allow-Headers",
    );
    assert.equal(allowed, BASE_ALLOWED);
  });
});

const server = createServer(
  asNodeHandler(buildParamHandler().handler, {
    origin: "https://example.test",
    allowedOrigins: ["https://example.test"],
  }),
);
const listening = new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
});
after(() => server.close());

const post = async (headers: Record<string, string | string[]>) => {
  const port = await listening;
  const call = modernWith("tools/call", { name: "annotated", arguments: { region: "a, a" } });
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        headers: { "Content-Type": "application/json", ...call.headers, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(call.body));
  });
};

describe("a repeated Mcp-Param-* header on the Node adapter", () => {
  it("a single header holding a comma is accepted (control)", async () => {
    const { status } = await post({ "Mcp-Param-Region": "a, a" });
    assert.equal(status, 200);
  });

  it("two headers that the platform would merge into the body value are refused", async () => {
    const { status, text } = await post({ "Mcp-Param-Region": ["a", "a"] });
    assert.equal(status, 400);
    assert.equal(JSON.parse(text).error.code, -32020);
  });

  it("a repeated header the tool does not annotate is still ignored", async () => {
    const { status } = await post({
      "Mcp-Param-Region": "a, a",
      "Mcp-Param-Unknown": ["x", "y"],
    });
    assert.equal(status, 200);
  });
});
