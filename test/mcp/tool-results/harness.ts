/** One handler over the given tools, and request builders for a legacy and a 2026-07-28 client. */

import { createMcpHandler } from "../../../src/mcp/dispatch.js";
import {
  createToolRegistry,
  type RegistryOptions,
  type ToolDef,
} from "../../../src/mcp/registry.js";
import { modern, rpc, send } from "../modern/harness.js";

type Ctx = Record<string, never>;

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] as const;

const TOKEN = "t";

export const buildHandler = (tools: ToolDef<Ctx>[], options: RegistryOptions = {}) =>
  createMcpHandler<Ctx>({
    registry: createToolRegistry<Ctx>(tools, options),
    serverInfo: { name: "test", version: "0.0.1" },
    wwwAuthenticate: { realm: "test", resourceMetadataUrl: "https://example.test/.well-known/x" },
    ports: {
      authenticate: async () => ({ id: "u1", scopes: [], claims: {} }),
      context: async () => ({}),
      audit: () => undefined,
    },
  });

export type Wire = {
  result: {
    content?: Array<{ text: string }>;
    structuredContent?: unknown;
    isError?: boolean;
    tools?: Array<Record<string, unknown>>;
  };
};

const legacyCall = (version: string, method: string, params: Record<string, unknown>) => ({
  body: rpc(method, params),
  headers: { "MCP-Protocol-Version": version },
  token: TOKEN,
});

export const requestAs = async (
  version: string,
  tools: ToolDef<Ctx>[],
  method: "tools/call" | "tools/list",
  params: Record<string, unknown> = {},
): Promise<Wire> => {
  const call =
    version === MODERN_VERSION
      ? modern(method, params, TOKEN)
      : legacyCall(version, method, params);
  return (await (await send(buildHandler(tools), call)).json()) as Wire;
};
