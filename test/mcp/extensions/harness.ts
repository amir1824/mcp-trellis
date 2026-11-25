/** Fixtures for the extension and `x-mcp-header` tests: a modern call that declares chosen extensions, and a tool with annotated parameters. */

import { createMcpHandler } from "../../../src/mcp/dispatch.js";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import type { JsonSchema } from "../../../src/mcp/schema/types.js";
import { type Call, INGEST_TOKEN, MODERN_VERSION, rpc, send } from "../modern/harness.js";

export { buildHandler, INGEST_TOKEN, send } from "../modern/harness.js";

export const UI_ID = "io.modelcontextprotocol/ui";

/** A 2026-07-28 call; `extensions` is placed in `clientCapabilities` as given, so malformed shapes can be sent. */
export const modernWith = (
  method: string,
  params: Record<string, unknown>,
  extensions?: unknown,
): Call => {
  const named = params.name ?? params.uri;
  return {
    token: INGEST_TOKEN,
    body: rpc(method, {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientCapabilities":
          extensions === undefined ? {} : { extensions },
      },
    }),
    headers: {
      "MCP-Protocol-Version": MODERN_VERSION,
      "Mcp-Method": method,
      ...(typeof named === "string" ? { "Mcp-Name": named } : {}),
    },
  };
};

export const legacyCall = (method: string, params: Record<string, unknown> = {}): Call => ({
  token: INGEST_TOKEN,
  body: rpc(method, params),
});

export const withUiDeclared = { [UI_ID]: { mimeTypes: ["text/html;profile=mcp-app"] } };

export const PARAM_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    count: { type: "integer", "x-mcp-header": "Count" },
    flag: { type: "boolean", "x-mcp-header": "Flag" },
    plain: { type: "string" },
    nested: { type: "object", properties: { zone: { type: "string", "x-mcp-header": "Zone" } } },
  },
};

export type ParamEnv = {
  handler: ReturnType<typeof createMcpHandler>;
  ran: { count: number };
  audits: string[];
};

export const buildParamHandler = (): ParamEnv => {
  const ran = { count: 0 };
  const audits: string[] = [];
  const registry = createToolRegistry<object>([
    {
      name: "annotated",
      description: "has mirrored params",
      inputSchema: PARAM_SCHEMA,
      handler: () => {
        ran.count += 1;
        return "ok";
      },
    },
  ]);
  const handler = createMcpHandler<object>({
    registry,
    serverInfo: { name: "t", version: "1" },
    wwwAuthenticate: { realm: "t", resourceMetadataUrl: "https://example.test/.well-known/x" },
    ports: {
      authenticate: async () => ({ id: "u", scopes: ["*"] }),
      context: async () => ({}),
      audit: (entry) => {
        audits.push(`${entry.tool ?? ""}|${entry.ok}|${entry.error ?? ""}`);
      },
    },
  });
  return { handler, ran, audits };
};

export const callAnnotated = (
  env: ParamEnv,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> =>
  send(env.handler, {
    body: modernWith("tools/call", { name: "annotated", arguments: args }).body,
    headers: {
      ...modernWith("tools/call", { name: "annotated" }).headers,
      ...headers,
    },
  });
