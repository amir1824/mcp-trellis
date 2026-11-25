import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Principal } from "../../../src/mcp/types.js";
import {
  ADMIN_SECRET,
  ADMIN_TOOL,
  capturePost,
  listedResourceUris,
  listedSkills,
  listedSkillUris,
  makeSkillEnv,
  makeSkills,
  rpc,
  SKILL_URIS,
  TOKENS,
} from "./harness.js";

const INVALID_PARAMS = -32602;
const INSUFFICIENT_SCOPE = -32003;
const HIDING_MODES = [true, "strict"] as const;

const SKILL_ROWS = [
  ["alice (read, acme)", TOKENS.alice, [SKILL_URIS.refunds, SKILL_URIS.acme, SKILL_URIS.open]],
  ["bob (read and write, globex)", TOKENS.bob, [SKILL_URIS.refunds, SKILL_URIS.open]],
  ["carol (write, initech)", TOKENS.carol, [SKILL_URIS.open]],
  ["eve (no scopes)", TOKENS.eve, [SKILL_URIS.open]],
  [
    "root (*), but allow still applies",
    TOKENS.root,
    [SKILL_URIS.refunds, SKILL_URIS.admin, SKILL_URIS.open],
  ],
] as const;

/** Every address that must never reach the admin skill's files, for a principal who may not read them. */
const ADMIN_ADDRESSES = [
  SKILL_URIS.admin,
  SKILL_URIS.adminRunbook,
  "skill://ADMIN-OPS/SKILL.md",
  "skill://admin-ops/RUNBOOK.md",
  "skill://admin-ops/SKILL.MD",
  "skill://admin-ops/",
  "skill://admin-ops",
  "skill://admin-ops/%72unbook.md",
  "skill://refunds/../admin-ops/SKILL.md",
  "skill://refunds/references/../../admin-ops/runbook.md",
  "skill://refunds/runbook.md",
  "skill://admin-ops//runbook.md",
  "skill://admin-ops/./runbook.md",
  "skill://admin-ops/runbook.md#",
  "skill://admin-ops/runbook.md?",
  "skill://admin-ops/runbook.md\u0000",
  "skill://admin-ops\\runbook.md",
  "SKILL://admin-ops/SKILL.md",
] as const;

const HIDDEN_SKILLS = [
  ["admin-ops", SKILL_URIS.admin],
  ["acme-only", SKILL_URIS.acme],
] as const;

/** A server that registers `name` and one that registers every other skill: a request for it is unknown on the second. */
const withAndWithout = (name: string, hideToolsOutsideScope: boolean | "strict") => {
  const options = { hideToolsOutsideScope };
  return {
    registered: makeSkillEnv({ options }),
    unregistered: makeSkillEnv({
      skills: makeSkills().filter((skill) => skill.name !== name),
      options,
    }),
  };
};

describe("skills authz R4 R11 M1 M3", () => {
  describe("R4 listing is filtered per skill by scope and allow", () => {
    SKILL_ROWS.forEach(([who, token, expected]) => {
      it(`R4 M1 skills/list shows ${who} only what it may read`, async () => {
        assert.deepEqual(await listedSkillUris(makeSkillEnv(), token), expected);
      });
    });

    it("R4 M1 resources/list shows the files of exactly the skills that skills/list shows", async () => {
      const uris = await listedResourceUris(makeSkillEnv(), TOKENS.bob);
      assert.deepEqual(uris, [SKILL_URIS.refunds, SKILL_URIS.refundsPolicy, SKILL_URIS.open]);
    });

    HIDING_MODES.forEach((mode) => {
      it(`R11 skills/list is the same under hideToolsOutsideScope ${String(mode)}`, async () => {
        const env = makeSkillEnv({ options: { hideToolsOutsideScope: mode } });
        assert.deepEqual(await listedSkillUris(env, TOKENS.alice), SKILL_ROWS[0][2]);
      });
    });
  });

  describe("M1 a principal without the scope receives nothing of the skill", () => {
    it("M1 carol holds write, alice holds read: only alice gets the refunds skill, on the same server", async () => {
      const env = makeSkillEnv();
      const answers = await Promise.all(
        [TOKENS.alice, TOKENS.carol].map(async (token) => ({
          get: await rpc(env, "skills/get", { uri: SKILL_URIS.refunds }, token),
          md: await rpc(env, "resources/read", { uri: SKILL_URIS.refunds }, token),
          file: await rpc(env, "resources/read", { uri: SKILL_URIS.refundsPolicy }, token),
        })),
      );
      const [alice, carol] = answers;
      assert.equal(alice?.get.status, 200);
      assert.equal(alice?.md.status, 200);
      assert.deepEqual([carol?.get.status, carol?.md.status, carol?.file.status], [403, 403, 403]);
      assert.equal(JSON.stringify(carol).includes("Remboursement"), false);
    });

    it("M1 R4 by default a missing scope answers 403 insufficient_scope naming the scope, on get and read", async () => {
      const env = makeSkillEnv();
      const get = await rpc(env, "skills/get", { uri: SKILL_URIS.admin }, TOKENS.alice);
      const read = await rpc(env, "resources/read", { uri: SKILL_URIS.adminRunbook }, TOKENS.alice);
      assert.equal(get.status, 403);
      assert.equal(get.body.error?.code, INSUFFICIENT_SCOPE);
      assert.match(get.challenge ?? "", /error="insufficient_scope".*scope="admin"/);
      assert.equal(read.status, 403);
      assert.equal(`${get.text}${read.text}`.includes(ADMIN_SECRET), false);
    });

    it("M1 a false allow answers like an unknown skill, with no scope to step up to", async () => {
      const reply = await rpc(makeSkillEnv(), "skills/get", { uri: SKILL_URIS.acme }, TOKENS.bob);
      assert.equal(reply.status, 200);
      assert.equal(reply.challenge, null);
      assert.equal(reply.body.error?.code, INVALID_PARAMS);
      assert.equal(reply.body.error?.message, `Unknown skill: ${SKILL_URIS.acme}`);
    });

    it("M1 a throwing allow, or one that is not exactly true, denies and leaks nothing of the exception", async () => {
      const lax = ["yes", Promise.resolve(true), 1].map((value, index) => ({
        name: `lax-${index}`,
        description: "d",
        instructions: "never served",
        allow: (() => value) as unknown as () => boolean,
      }));
      const throwing = {
        name: "throws",
        description: "d",
        instructions: "never served",
        allow: () => {
          throw new Error("SECRET-ALLOW-DETAIL");
        },
      };
      const env = makeSkillEnv({ skills: [...lax, throwing] });
      assert.deepEqual(await listedSkillUris(env, TOKENS.root), []);
      const reply = await rpc(env, "skills/get", { uri: "skill://throws/SKILL.md" }, TOKENS.root);
      assert.equal(reply.text.includes("SECRET-ALLOW-DETAIL"), false);
    });

    ADMIN_ADDRESSES.slice(2).forEach((address) => {
      it(`M3 M1 ${JSON.stringify(address)} is unknown on read and get, even to the * principal`, async () => {
        const env = makeSkillEnv();
        const read = await rpc(env, "resources/read", { uri: address }, TOKENS.root);
        const get = await rpc(env, "skills/get", { uri: address }, TOKENS.root);
        assert.deepEqual(
          [read.body.error?.code, get.body.error?.code],
          [INVALID_PARAMS, INVALID_PARAMS],
        );
        assert.equal(`${read.text}${get.text}`.includes(ADMIN_SECRET), false);
      });
    });

    it("M3 an address that names a declared file under another skill's prefix is unknown", async () => {
      const reply = await rpc(
        makeSkillEnv(),
        "resources/read",
        { uri: "skill://refunds/runbook.md" },
        TOKENS.root,
      );
      assert.equal(reply.body.error?.message, "Unknown resource: skill://refunds/runbook.md");
    });
  });

  describe("R11 a skill the caller may not see answers like an unknown skill", () => {
    HIDING_MODES.forEach((mode) => {
      HIDDEN_SKILLS.forEach(([name, uri]) => {
        it(`R11 ${String(mode)}: skills/get of ${name} answers the bytes of a server that lacks it`, async () => {
          const { registered, unregistered } = withAndWithout(name, mode);
          const hidden = await capturePost(registered, "skills/get", { uri }, TOKENS.eve);
          const unknown = await capturePost(unregistered, "skills/get", { uri }, TOKENS.eve);
          assert.deepEqual(hidden, unknown);
          assert.equal(JSON.parse(hidden.body).error.code, INVALID_PARAMS);
        });

        it(`R11 ${String(mode)}: resources/read of ${name} answers the bytes of a server that lacks it`, async () => {
          const { registered, unregistered } = withAndWithout(name, mode);
          const hidden = await capturePost(registered, "resources/read", { uri }, TOKENS.eve);
          const unknown = await capturePost(unregistered, "resources/read", { uri }, TOKENS.eve);
          assert.deepEqual(hidden, unknown);
        });
      });

      it(`R11 ${String(mode)}: an unauthorized tool, resource and skill are all hidden in the same run`, async () => {
        const resources = [
          { uri: "docs://admin", name: "Admin doc", scope: "admin", read: () => "admin doc" },
        ];
        const env = makeSkillEnv({ options: { resources, hideToolsOutsideScope: mode } });
        const tools = await rpc(env, "tools/list", undefined, TOKENS.alice);
        const listed = JSON.stringify(tools.body.result);
        const resourceUris = await listedResourceUris(env, TOKENS.alice);
        const skillUris = await listedSkillUris(env, TOKENS.alice);
        assert.equal(listed.includes(ADMIN_TOOL), false);
        assert.equal(resourceUris.includes("docs://admin"), false);
        assert.equal(skillUris.includes(SKILL_URIS.admin), false);
      });
    });

    it("R11 strict: a call of the unauthorized tool, and a read of the unauthorized skill, both answer as unknown", async () => {
      const env = makeSkillEnv({ options: { hideToolsOutsideScope: "strict" } });
      const tool = await rpc(env, "tools/call", { name: ADMIN_TOOL, arguments: {} }, TOKENS.alice);
      const skill = await rpc(env, "skills/get", { uri: SKILL_URIS.admin }, TOKENS.alice);
      assert.equal(tool.body.error?.message, `Unknown tool: ${ADMIN_TOOL}`);
      assert.equal(skill.body.error?.message, `Unknown skill: ${SKILL_URIS.admin}`);
    });
  });

  describe("R4 one allow decision per skill and request", () => {
    it("R4 a stateful allow shows all the files of a skill or none, and runs once per request", async () => {
      const decisions = { calls: 0 };
      const toggling = {
        name: "toggle",
        description: "d",
        instructions: "# T\n",
        files: [
          { path: "a.md", text: "a" },
          { path: "b.md", text: "b" },
        ],
        allow: (_principal: Principal) => {
          decisions.calls += 1;
          return decisions.calls % 2 === 1;
        },
      };
      const env = makeSkillEnv({ skills: [toggling] });
      const first = await listedResourceUris(env, TOKENS.alice);
      const second = await listedResourceUris(env, TOKENS.alice);
      assert.deepEqual(first, [
        "skill://toggle/SKILL.md",
        "skill://toggle/a.md",
        "skill://toggle/b.md",
      ]);
      assert.deepEqual(second, []);
      assert.equal(decisions.calls, 2);
    });
  });

  describe("R4 a stateful allow is decided once per request, never cached", () => {
    it("R4 M4 an allow that says yes only to its first call: skills/list shows the skill with every file, then resources/list shows none", async () => {
      const decisions = { calls: 0 };
      const once = {
        name: "once",
        description: "d",
        instructions: "# O\n",
        files: [
          { path: "a.md", text: "a" },
          { path: "b.md", text: "b" },
        ],
        allow: (_principal: Principal) => {
          decisions.calls += 1;
          return decisions.calls === 1;
        },
      };
      const env = makeSkillEnv({ skills: [once] });
      const [entry] = await listedSkills(env, TOKENS.alice);
      const afterwards = await listedResourceUris(env, TOKENS.alice);
      assert.deepEqual(
        entry?.resources.map(({ uri }) => uri),
        ["skill://once/SKILL.md", "skill://once/a.md", "skill://once/b.md"],
      );
      assert.deepEqual(afterwards, []);
      assert.equal(decisions.calls, 2);
    });
  });

  describe("R4 each call is audited under its own method", () => {
    it("R4 skills/list, a granted and a refused skills/get and an unknown one leave their own entries", async () => {
      const env = makeSkillEnv();
      await rpc(env, "skills/list", undefined, TOKENS.alice);
      await rpc(env, "skills/get", { uri: SKILL_URIS.open }, TOKENS.alice);
      await rpc(env, "skills/get", { uri: SKILL_URIS.admin }, TOKENS.alice);
      await rpc(env, "skills/get", { uri: "skill://nope/SKILL.md" }, TOKENS.alice);
      assert.deepEqual(
        env.audits.map(({ method, ok, error }) => `${method}|${ok}|${error ?? ""}`),
        [
          "skills/list|true|",
          "skills/get|true|",
          "skills/get|false|missing_scope",
          "skills/get|false|unknown_resource",
        ],
      );
    });
  });
});
