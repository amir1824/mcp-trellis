/** Shared fixtures for the 2026-07-28 tests: one handler, two principals, a UI tool, and request builders. */

import { DEFAULT_MCP_BODY_LIMIT } from "../../../src/http/body.js";
import { createMcpHandler, type McpHandler } from "../../../src/mcp/dispatch.js";
import { createToolRegistry } from "../../../src/mcp/registry.js";
import type { McpHandlerOptions, Principal } from "../../../src/mcp/types.js";

export const MODERN_VERSION = "2026-07-28";
export const READ_TOKEN = "read-tok";
export const INGEST_TOKEN = "ingest-tok";

/** The bearer header each token maps to: a lookup, so the stub authenticator has no branches. */
const PRINCIPALS_BY_AUTHORIZATION: ReadonlyMap<string, Principal> = new Map([
  [`Bearer ${READ_TOKEN}`, { id: "u1", scopes: ["read"], claims: { tenant: "acme" } }],
  [
    `Bearer ${INGEST_TOKEN}`,
    { id: "u2", scopes: ["ingest", "read"], claims: { tenant: "globex" } },
  ],
]);

type Ctx = { who: string };
type HandlerOverrides = Partial<McpHandlerOptions<Ctx>>;

export type Built = { handler: McpHandler; toolCalls: { count: number }; audits: string[] };

/** A fresh handler per call, so no test shares a counter or an audit list with another. */
export const buildHandler = (overrides: HandlerOverrides = {}, withUi = false): Built => {
  const toolCalls = { count: 0 };
  const audits: string[] = [];
  const registry = createToolRegistry<Ctx>([
    {
      name: "echo",
      description: "echo args",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      scope: "read",
      handler: (_ctx, args) => {
        toolCalls.count += 1;
        return String(args.text ?? "");
      },
    },
    {
      name: "secret_write",
      description: "needs ingest",
      inputSchema: { type: "object", properties: {} },
      scope: "ingest",
      handler: () => {
        toolCalls.count += 1;
        return "written";
      },
    },
    ...(withUi
      ? [
          {
            name: "show",
            description: "shows a view",
            inputSchema: { type: "object" as const, properties: {} },
            scope: "ingest",
            ui: { resourceUri: "ui://test/view" },
            handler: () => "shown",
          },
        ]
      : []),
  ]);
  const handler = createMcpHandler<Ctx>({
    registry,
    serverInfo: { name: "test", version: "0.0.1" },
    instructions: "test server",
    wwwAuthenticate: {
      realm: "test",
      resourceMetadataUrl: "https://example.test/.well-known/oauth-protected-resource/mcp",
    },
    ...(withUi ? { uiResources: [{ uri: "ui://test/view", html: "<p>view</p>" }] } : {}),
    ports: {
      authenticate: async (req) =>
        PRINCIPALS_BY_AUTHORIZATION.get(req.headers.get("authorization") ?? "") ?? null,
      context: async () => ({ who: "tester" }),
      audit: (entry) => {
        audits.push(`${entry.method}|${entry.tool ?? ""}|${entry.ok}`);
      },
    },
    ...overrides,
  });
  return { handler, toolCalls, audits };
};

export type Call = {
  body: unknown;
  headers?: Record<string, string>;
  token?: string;
  method?: string;
};

export const send = (handler: McpHandler, call: Call): Promise<Response> =>
  handler.fetch(
    new Request("https://example.test/mcp", {
      method: call.method ?? "POST",
      headers: {
        "Content-Type": "application/json",
        ...(call.token ? { Authorization: `Bearer ${call.token}` } : {}),
        ...call.headers,
      },
      ...((call.method ?? "POST") === "POST"
        ? { body: typeof call.body === "string" ? call.body : JSON.stringify(call.body) }
        : {}),
    }),
  );

export const rpc = (method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params === undefined ? {} : { params }),
});

/** The request `_meta` 2026-07-28 requires. */
export const modernMeta = (extensions?: Record<string, object>) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
  "io.modelcontextprotocol/clientCapabilities": extensions ? { extensions } : {},
});

/** A complete 2026-07-28 request: required `_meta`, and the standard headers copied from the body. */
export const modern = (
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
  extensions?: Record<string, object>,
): Call => {
  const named = params.name ?? params.uri;
  return {
    body: rpc(method, { ...params, _meta: modernMeta(extensions) }),
    headers: {
      "MCP-Protocol-Version": MODERN_VERSION,
      "Mcp-Method": method,
      ...(typeof named === "string" ? { "Mcp-Name": named } : {}),
    },
    ...(token ? { token } : {}),
  };
};

export type Captured = { status: number; headers: Record<string, string>; body: string };

export const capture = async (res: Response): Promise<Captured> => {
  const entries: Array<[string, string]> = [];
  res.headers.forEach((value, key) => {
    entries.push([key, value]);
  });
  return {
    status: res.status,
    headers: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))),
    body: await res.text(),
  };
};

export const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

export const oversizedBody = (): string => "x".repeat(DEFAULT_MCP_BODY_LIMIT + 1);
