#!/usr/bin/env node
/**
 * Baseline request latency for the MCP handler (docs/modernization/baselines.md).
 * Needs `npm run build`. Prints numbers only: writes no file, reads no environment secret, and
 * binds 127.0.0.1 on an ephemeral port. What it measures, and what it leaves out, is printed.
 */
import http from "node:http";
import { performance } from "node:perf_hooks";
import { asNodeHandler } from "../dist/adapters/node.js";
import { createMcpHandler, createToolRegistry } from "../dist/server.js";

const WARMUP = 200;
const SAMPLES = 2000;
const PROTOCOL_VERSION = "2025-06-18";
const MEDIAN = 0.5;
const P95 = 0.95;

const RESOURCE_COUNT = 50;
const RESOURCE_URI = "docs://baseline/25";

const resources = Array.from({ length: RESOURCE_COUNT }, (_, index) => ({
  uri: `docs://baseline/${index}`,
  name: `Baseline ${index}`,
  scope: "mcp",
  read: () => `resource ${index}`,
}));

const registry = createToolRegistry([
  {
    name: "echo",
    description: "Echo text back",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    scope: "mcp",
    handler: (_ctx, args) => String(args.text ?? ""),
  },
]);

const handler = createMcpHandler({
  registry,
  resources,
  serverInfo: { name: "baseline", version: "0.0.0" },
  wwwAuthenticate: { realm: "mcp", resourceMetadataUrl: "http://127.0.0.1/.well-known" },
  ports: {
    authenticate: async () => ({ id: "baseline-user", scopes: ["mcp"] }),
    context: () => ({}),
  },
});

const REQUESTS = {
  "tools/list": { jsonrpc: "2.0", id: 1, method: "tools/list" },
  "tools/call": {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "echo", arguments: { text: "hello" } },
  },
  "resources/list": { jsonrpc: "2.0", id: 3, method: "resources/list" },
  "resources/read": {
    jsonrpc: "2.0",
    id: 4,
    method: "resources/read",
    params: { uri: RESOURCE_URI },
  },
};

const headers = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": PROTOCOL_VERSION,
  authorization: "Bearer baseline",
};

const percentile = (sorted, fraction) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

const measure = async (send) => {
  for (let index = 0; index < WARMUP; index += 1) await send();
  const samples = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const startedAt = performance.now();
    await send();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  return {
    p50Ms: Number(percentile(samples, MEDIAN).toFixed(3)),
    p95Ms: Number(percentile(samples, P95).toFixed(3)),
  };
};

const report = (scenario, method, result) =>
  console.log(JSON.stringify({ scenario, method, warmup: WARMUP, samples: SAMPLES, ...result }));

const server = http.createServer(asNodeHandler(handler, { origin: "http://127.0.0.1" }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

try {
  for (const [method, body] of Object.entries(REQUESTS)) {
    const payload = JSON.stringify(body);
    report(
      "handler.fetch in-process",
      method,
      await measure(async () => {
        const response = await handler.fetch(
          new Request("http://127.0.0.1/mcp", { method: "POST", headers, body: payload }),
        );
        await response.text();
      }),
    );
    report(
      "node http loopback",
      method,
      await measure(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers,
          body: payload,
        });
        await response.text();
      }),
    );
  }
} finally {
  server.close();
}

console.log(
  JSON.stringify({
    node: process.version,
    measured: "handler core path and Node adapter on loopback, one fixed principal",
    notMeasured:
      "OAuth endpoints, network latency, edge runtimes, host ports (real auth, context, audit)",
  }),
);
