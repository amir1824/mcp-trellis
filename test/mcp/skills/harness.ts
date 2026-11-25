/** Fixtures for the Skills tests: skills for each access rule, an admin tool a skill names, and request helpers. */

import type { ToolDef } from "../../../src/mcp/registry.js";
import type { SkillDef } from "../../../src/mcp/skills/types.js";
import type { McpHandlerOptions, Principal } from "../../../src/mcp/types.js";
import { type Call, capture, send } from "../modern/harness.js";
import { type Ctx, type Env, makeEnv, rpc, TOKENS } from "../ui/harness.js";

export type { Env };
export { capture, rpc, TOKENS };

export const SKILL_URIS = {
  refunds: "skill://refunds/SKILL.md",
  refundsPolicy: "skill://refunds/references/policy.md",
  admin: "skill://admin-ops/SKILL.md",
  adminRunbook: "skill://admin-ops/runbook.md",
  acme: "skill://acme-only/SKILL.md",
  open: "skill://open-skill/SKILL.md",
} as const;

export const ADMIN_TOOL = "purge_data";
export const POLICY_TEXT = "Remboursement: café, 100 € maximum\n";
export const ADMIN_SECRET = "ADMIN-RUNBOOK-SECRET-7731";
export const ACME_TENANT = "acme";
export const REFUNDS_DESCRIPTION = "Process customer refund requests per company policy";

/** What a modern request needs to carry: the standard headers and `_meta`. */
export const MODERN_VERSION = "2026-07-28";

export const makeSkills = (): SkillDef[] => [
  {
    name: "refunds",
    description: REFUNDS_DESCRIPTION,
    instructions: "# Refunds\n\nSee references/policy.md.\n",
    metadata: { owner: "billing" },
    scope: "read",
    files: [{ path: "references/policy.md", text: POLICY_TEXT }],
  },
  {
    name: "admin-ops",
    description: "Operate the admin console",
    instructions: `# Admin\n\nCall the tool ${ADMIN_TOOL} to clean up.\n`,
    scope: "admin",
    files: [{ path: "runbook.md", text: ADMIN_SECRET }],
  },
  {
    name: "acme-only",
    description: "Only for the acme tenant",
    instructions: "# Acme\n",
    allow: (principal: Principal) => principal.claims?.tenant === ACME_TENANT,
  },
  {
    name: "open-skill",
    description: "Open to anyone signed in",
    instructions: "# Open\n",
    scope: null,
  },
];

export type SkillEnv = Env & { adminCalls: { count: number } };

/** `skills: null` leaves the option out entirely. */
type SkillEnvInput = { skills?: SkillDef[] | null; options?: Partial<McpHandlerOptions<Ctx>> };

export const makeSkillEnv = ({ skills = makeSkills(), options }: SkillEnvInput = {}): SkillEnv => {
  const adminCalls = { count: 0 };
  const tools: ToolDef<Ctx>[] = [
    {
      name: ADMIN_TOOL,
      description: "Admin only",
      inputSchema: { type: "object", properties: {} },
      scope: "admin",
      handler: () => {
        adminCalls.count += 1;
        return "purged";
      },
    },
  ];
  const env = makeEnv({
    tools,
    resources: null,
    options: { ...(skills === null ? {} : { skills }), ...options },
  });
  return { ...env, adminCalls };
};

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

export const sendCall = (env: Env, call: Call): Promise<Response> => send(env.handler, call);

type Entry = {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Array<{ uri: string; digest: string; size: number }>;
};

export const listedSkills = async (env: Env, token: string): Promise<Entry[]> => {
  const reply = await rpc(env, "skills/list", undefined, token);
  return (reply.body.result as { skills: Entry[] }).skills;
};

export const listedSkillUris = async (env: Env, token: string): Promise<string[]> =>
  (await listedSkills(env, token)).map(({ uri }) => uri);

export const listedResourceUris = async (env: Env, token: string): Promise<string[]> => {
  const reply = await rpc(env, "resources/list", undefined, token);
  const result = reply.body.result as { resources: Array<{ uri: string }> };
  return result.resources.map(({ uri }) => uri);
};

/** The shape one SKILL.md line parser reads back: `key: <JSON>` between two `---` lines. */
export const parseFrontmatter = (skillMd: string): Record<string, unknown> => {
  const [, block = ""] = skillMd.split("---\n");
  return Object.fromEntries(
    block
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const at = line.indexOf(": ");
        return [line.slice(0, at), JSON.parse(line.slice(at + 2))];
      }),
  );
};

/** Lists for each token in turn, one request after the other, and returns what each saw. */
export const listInTurn = async (env: Env, tokens: readonly string[]): Promise<Entry[][]> => {
  const seen: Entry[][] = [];
  for (const token of tokens) seen.push(await listedSkills(env, token));
  return seen;
};
