/** Fixtures for the general-resources tests: two tenants, a tenant-aware provider with a call counter, and request helpers. */

import type { ToolDef } from "../../../src/mcp/registry.js";
import type { ResourceDef } from "../../../src/mcp/resources/types.js";
import type { McpHandlerOptions, Principal } from "../../../src/mcp/types.js";
import { type Call, capture, send } from "../modern/harness.js";
import { type Ctx, type Env, makeEnv, rpc, TOKENS } from "../ui/harness.js";

export type { Env };
export { capture, rpc, TOKENS };

/** A name and URI per fixture, so a test names the row it is about. */
export const URIS = {
  handbook: "docs://acme/handbook",
  open: "docs://open",
  admin: "docs://admin/keys",
  acmeOnly: "docs://rules/acme-only",
  broken: "docs://rules/broken-allow",
  tenant: "tenant://report",
  typed: "docs://typed/csv",
} as const;

export const HANDBOOK_TEXT = "handbook text";
export const ADMIN_TEXT = "admin key material";
export const ADMIN_DESCRIPTION = "private admin description";
export const ACME_TENANT = "acme";
export const CONCURRENT_READS = 50;
export const MAX_PROVIDER_DELAY_MS = 8;
export const SECRET_FRAGMENT = "SECRET-DB-PASSWORD-hunter2";

const PLAIN_TOOLS: ToolDef<Ctx>[] = [
  {
    name: "plain_tool",
    description: "No UI",
    inputSchema: { type: "object", properties: {} },
    scope: "read",
    handler: () => "plain",
  },
];

export type Reads = { count: number };

const sleepRandom = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.random() * MAX_PROVIDER_DELAY_MS));

/** A fresh set of resources and a fresh provider call counter per test. */
export const makeFixture = (): { resources: ResourceDef<Ctx>[]; reads: Reads } => {
  const reads: Reads = { count: 0 };
  const counted = <T>(value: (ctx: Ctx) => T) => {
    return (ctx: Ctx): T => {
      reads.count += 1;
      return value(ctx);
    };
  };
  const resources: ResourceDef<Ctx>[] = [
    {
      uri: URIS.handbook,
      name: "Handbook",
      description: "Team handbook",
      scope: "read",
      read: counted(() => HANDBOOK_TEXT),
    },
    { uri: URIS.open, name: "Open", scope: null, read: counted(() => "open text") },
    {
      uri: URIS.admin,
      name: "Admin keys",
      description: ADMIN_DESCRIPTION,
      scope: "admin",
      read: counted(() => ADMIN_TEXT),
    },
    {
      uri: URIS.acmeOnly,
      name: "Acme only",
      allow: (principal: Principal) => principal.claims?.tenant === ACME_TENANT,
      read: counted(() => "acme rule text"),
    },
    {
      uri: URIS.broken,
      name: "Broken allow",
      allow: () => {
        throw new Error(SECRET_FRAGMENT);
      },
      read: counted(() => "never served"),
    },
    {
      uri: URIS.tenant,
      name: "Tenant report",
      read: async (ctx: Ctx) => {
        reads.count += 1;
        await sleepRandom();
        return `${ctx.tenant} report`;
      },
    },
    {
      uri: URIS.typed,
      name: "Typed",
      mimeType: "text/csv",
      read: counted(() => ({ text: "a,b", mimeType: "text/csv" })),
    },
  ];
  return { resources, reads };
};

export type ResourceEnv = Env & { reads: Reads };

type ResourceEnvInput = {
  resources?: ResourceDef<Ctx>[];
  /** Adds the shop UI documents and their tools to the same server. */
  withUi?: boolean;
  options?: Partial<McpHandlerOptions<Ctx>>;
};

export const makeResourceEnv = ({
  resources,
  withUi = false,
  options,
}: ResourceEnvInput = {}): ResourceEnv => {
  const fixture = makeFixture();
  const env = makeEnv({
    ...(withUi ? {} : { tools: PLAIN_TOOLS, resources: null }),
    options: { resources: resources ?? fixture.resources, ...options },
  });
  return { ...env, reads: fixture.reads };
};

/** The full response, for byte comparison: status, every header and the exact body. */
export const post = (
  env: Env,
  method: string,
  params?: Record<string, unknown>,
  token?: string,
): Promise<Response> =>
  send(env.handler, {
    body: { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) },
    ...(token === undefined ? {} : { token }),
  });

export const capturePost = async (
  env: Env,
  method: string,
  params?: Record<string, unknown>,
  token?: string,
) => capture(await post(env, method, params, token));

export const listedUris = async (env: Env, token: string): Promise<string[]> => {
  const reply = await rpc(env, "resources/list", undefined, token);
  const result = reply.body.result as { resources: Array<{ uri: string }> };
  return result.resources.map((resource) => resource.uri);
};

export const sendCall = (env: Env, call: Call): Promise<Response> => send(env.handler, call);

/** One concurrent read: who asks, and the text only that tenant may see. */
export const CONCURRENT_ROWS = Array.from({ length: CONCURRENT_READS / 2 }).flatMap(() => [
  { token: TOKENS.alice, expected: "acme report" },
  { token: TOKENS.bob, expected: "globex report" },
]);
