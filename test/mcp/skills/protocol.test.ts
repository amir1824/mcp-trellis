import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { json, modern } from "../modern/harness.js";
import { capturePost as captureResourcePost, makeResourceEnv } from "../resources/harness.js";
import {
  capture,
  capturePost,
  listedResourceUris,
  listedSkills,
  makeSkillEnv,
  POLICY_TEXT,
  REFUNDS_DESCRIPTION,
  rpc,
  SKILL_URIS,
  sendCall,
  TOKENS,
} from "./harness.js";

type Reply = {
  resultType?: string;
  ttlMs?: number;
  cacheScope?: string;
  skill?: { uri: string; frontmatter: Record<string, unknown> };
  skills?: unknown[];
  capabilities?: Record<string, unknown>;
  error?: { code: number; message: string };
};

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const EXTENSIONS = { "io.modelcontextprotocol/skills": {} };

const modernResult = async (method: string, params: Record<string, unknown>, token: string) => {
  const res = await sendCall(makeSkillEnv(), modern(method, params, token));
  return { res, body: await json<{ result?: Reply; error?: Reply["error"] }>(res) };
};

const BYTE_IDENTICAL_REQUESTS = [
  ["initialize", "initialize", undefined],
  ["server/discover", "server/discover", undefined],
  ["tools/list", "tools/list", undefined],
  ["resources/list", "resources/list", undefined],
  ["skills/list", "skills/list", undefined],
  ["skills/get", "skills/get", { uri: SKILL_URIS.open }],
] as const;

describe("skills protocol R3 R9 R12 R13", () => {
  describe("R3 the extension is declared and its methods answer", () => {
    it("R3 initialize declares resources and the skills extension, and no directoryRead", async () => {
      const reply = await rpc(makeSkillEnv(), "initialize", {});
      const { capabilities } = reply.body.result as Reply;
      assert.deepEqual(capabilities, { tools: {}, resources: {}, extensions: EXTENSIONS });
    });

    it("R3 server/discover declares the same, for a 2026-07-28 request", async () => {
      const { body } = await modernResult("server/discover", {}, TOKENS.alice);
      assert.deepEqual(body.result?.capabilities, {
        tools: {},
        resources: {},
        extensions: EXTENSIONS,
      });
    });

    it("R3 skills/list returns one entry per skill the caller may see, with its URI", async () => {
      const skills = await listedSkills(makeSkillEnv(), TOKENS.root);
      assert.deepEqual(
        skills.map(({ uri }) => uri),
        [SKILL_URIS.refunds, SKILL_URIS.admin, SKILL_URIS.open],
      );
    });

    it("R3 skills/get returns the entry of one skill under result.skill", async () => {
      const reply = await rpc(
        makeSkillEnv(),
        "skills/get",
        { uri: SKILL_URIS.refunds },
        TOKENS.alice,
      );
      const { skill } = reply.body.result as Reply;
      assert.equal(skill?.uri, SKILL_URIS.refunds);
      assert.equal(skill?.frontmatter.description, REFUNDS_DESCRIPTION);
    });

    it("R3 every file is read through resources/read as text, SKILL.md as markdown", async () => {
      const env = makeSkillEnv();
      const md = await rpc(env, "resources/read", { uri: SKILL_URIS.refunds }, TOKENS.alice);
      const file = await rpc(
        env,
        "resources/read",
        { uri: SKILL_URIS.refundsPolicy },
        TOKENS.alice,
      );
      const types = [md, file].map(
        (reply) =>
          (reply.body.result as { contents: Array<{ mimeType: string }> }).contents[0]?.mimeType,
      );
      assert.deepEqual(types, ["text/markdown", "text/markdown"]);
      assert.match(JSON.stringify(file.body.result), /Remboursement/);
    });

    it("R3 resources/list lists the SKILL.md and every file of each visible skill", async () => {
      const uris = await listedResourceUris(makeSkillEnv(), TOKENS.alice);
      assert.deepEqual(uris, [
        SKILL_URIS.refunds,
        SKILL_URIS.refundsPolicy,
        SKILL_URIS.acme,
        SKILL_URIS.open,
      ]);
    });

    it("R3 skills/get of a supporting file, an unknown URI or a non-string URI is -32602", async () => {
      const env = makeSkillEnv();
      const answers = await Promise.all(
        [SKILL_URIS.refundsPolicy, "skill://nope/SKILL.md", 7].map((uri) =>
          rpc(env, "skills/get", { uri }, TOKENS.root),
        ),
      );
      assert.deepEqual(
        answers.map((reply) => reply.body.error?.code),
        [INVALID_PARAMS, INVALID_PARAMS, INVALID_PARAMS],
      );
      assert.match(answers[0]?.body.error?.message ?? "", /^Unknown skill: skill:\/\/refunds\//);
      assert.equal(answers[2]?.body.error?.message, "skills/get params.uri must be a string");
    });

    it("R3 resources/directory/read is not implemented: directoryRead is never declared", async () => {
      const legacy = await rpc(
        makeSkillEnv(),
        "resources/directory/read",
        { uri: "skill://refunds" },
        TOKENS.root,
      );
      const res = await sendCall(
        makeSkillEnv(),
        modern("resources/directory/read", { uri: "skill://refunds" }, TOKENS.root),
      );
      assert.equal(legacy.body.error?.code, METHOD_NOT_FOUND);
      assert.equal((await json<{ error: { code: number } }>(res)).error.code, METHOD_NOT_FOUND);
    });
  });

  describe("R3 cache hints", () => {
    const CASES = [
      ["skills/list", {}],
      ["skills/get", { uri: SKILL_URIS.open }],
    ] as const;

    for (const [method, params] of CASES) {
      it(`R3 ${method} on 2026-07-28 carries resultType complete, ttlMs 0 and cacheScope private`, async () => {
        const { res, body } = await modernResult(method, params, TOKENS.alice);
        assert.equal(body.result?.resultType, "complete");
        assert.equal(body.result?.ttlMs, 0);
        assert.equal(body.result?.cacheScope, "private");
        assert.equal(res.headers.get("cache-control"), "no-store");
      });

      it(`R3 ${method} on a legacy request carries no resultType and no hints`, async () => {
        const reply = await rpc(makeSkillEnv(), method, params, TOKENS.alice);
        const keys = Object.keys(reply.body.result as object);
        assert.equal(
          keys.includes("resultType") || keys.includes("ttlMs") || keys.includes("cacheScope"),
          false,
        );
      });
    }
  });

  describe("R9 R12 without the option every answer is as before", () => {
    for (const [label, method, params] of BYTE_IDENTICAL_REQUESTS) {
      it(`R9 R12 ${label} answers the same with skills omitted and skills: []`, async () => {
        const omitted = makeSkillEnv({ skills: null });
        const empty = makeSkillEnv({ skills: [] });
        assert.deepEqual(
          await capturePost(empty, method, params, TOKENS.alice),
          await capturePost(omitted, method, params, TOKENS.alice),
        );
      });
    }

    it("R9 R12 a server without skills declares no extension and answers skills/* as unknown methods", async () => {
      const env = makeSkillEnv({ skills: [] });
      const init = await rpc(env, "initialize", {});
      const list = await rpc(env, "skills/list", undefined, TOKENS.root);
      const get = await rpc(env, "skills/get", { uri: SKILL_URIS.open }, TOKENS.root);
      assert.equal(JSON.stringify(init.body.result).includes("extensions"), false);
      assert.deepEqual(
        [list.body.error?.code, get.body.error?.code],
        [METHOD_NOT_FOUND, METHOD_NOT_FOUND],
      );
    });

    it("R9 R12 a server with resources but no skills has no skills/* and no extension", async () => {
      const resources = [{ uri: "docs://a", name: "A", read: () => "a" }];
      const env = makeSkillEnv({ skills: [], options: { resources } });
      const init = await rpc(env, "initialize", {});
      const list = await rpc(env, "skills/list", undefined, TOKENS.root);
      assert.deepEqual((init.body.result as Reply).capabilities, { tools: {}, resources: {} });
      assert.equal(list.body.error?.code, METHOD_NOT_FOUND);
    });

    it("R9 R12 skills/list needs a principal even when a host lists it in publicMethods", async () => {
      const env = makeSkillEnv({ options: { publicMethods: new Set(["skills/list"]) } });
      const reply = await rpc(env, "skills/list");
      assert.equal(reply.status, 401);
    });

    it("R12 skills sit beside UI documents and general resources in one catalog", async () => {
      const resources = [{ uri: "docs://a", name: "A", read: () => "a" }];
      const env = makeSkillEnv({ options: { resources } });
      const uris = await listedResourceUris(env, TOKENS.root);
      assert.deepEqual(uris.slice(0, 1), ["docs://a"]);
      assert.equal(uris.includes(SKILL_URIS.open), true);
    });
  });

  describe("R9 R12 the answers match a server that has T4 resources and never heard of skills", () => {
    const SKILLS_UNKNOWN =
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found: skills/list"}}';

    for (const method of ["initialize", "resources/list"] as const) {
      it(`R9 R12 ${method} equals the T4 server's bytes whether skills is omitted or empty`, async () => {
        const t4Only = await captureResourcePost(
          makeResourceEnv(),
          method,
          undefined,
          TOKENS.alice,
        );
        const emptySkills = await captureResourcePost(
          makeResourceEnv({ options: { skills: [] } }),
          method,
          undefined,
          TOKENS.alice,
        );
        assert.deepEqual(emptySkills, t4Only);
      });
    }

    it("R9 R12 the T4 server answers skills/list with exactly the unknown-method bytes", async () => {
      const t4Only = await captureResourcePost(
        makeResourceEnv(),
        "skills/list",
        undefined,
        TOKENS.alice,
      );
      assert.equal(t4Only.body, SKILLS_UNKNOWN);
      assert.equal(t4Only.status, 200);
    });
  });

  describe("R3 the Mcp-Name header of skills/get", () => {
    it("R3 a skills/get whose Mcp-Name names another uri is refused with 400", async () => {
      const call = modern("skills/get", { uri: SKILL_URIS.open }, TOKENS.alice);
      const res = await sendCall(makeSkillEnv(), {
        ...call,
        headers: { ...call.headers, "Mcp-Name": SKILL_URIS.refunds },
      });
      assert.equal(res.status, 400);
    });
  });

  describe("R13 a skill is served text and nothing more", () => {
    it("R13 reading a skill, its file and its entry runs no tool and no provider beyond context", async () => {
      const env = makeSkillEnv();
      await rpc(env, "skills/get", { uri: SKILL_URIS.admin }, TOKENS.root);
      await rpc(env, "resources/read", { uri: SKILL_URIS.admin }, TOKENS.root);
      await rpc(env, "resources/read", { uri: SKILL_URIS.adminRunbook }, TOKENS.root);
      assert.equal(env.adminCalls.count, 0);
    });

    it("R13 the served SKILL.md body is the text the host wrote, nothing generated into it", async () => {
      const read = await rpc(
        makeSkillEnv(),
        "resources/read",
        { uri: SKILL_URIS.refundsPolicy },
        TOKENS.alice,
      );
      assert.equal(
        (read.body.result as { contents: Array<{ text: string }> }).contents[0]?.text,
        POLICY_TEXT,
      );
    });
  });

  it("R3 skills/list answers the same bytes twice to the same caller", async () => {
    const env = makeSkillEnv();
    const first = capture(await sendCall(env, modern("skills/list", {}, TOKENS.alice)));
    const second = capture(await sendCall(env, modern("skills/list", {}, TOKENS.alice)));
    assert.deepEqual(await first, await second);
  });
});
