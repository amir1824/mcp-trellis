import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  listedSkills,
  listedSkillUris,
  listInTurn,
  makeSkillEnv,
  rpc,
  SKILL_URIS,
  TOKENS,
} from "./harness.js";

const ALTERNATIONS = 20;
const CONCURRENT_LISTS = 50;
const ALICE_SKILLS = [SKILL_URIS.refunds, SKILL_URIS.acme, SKILL_URIS.open];
const BOB_SKILLS = [SKILL_URIS.refunds, SKILL_URIS.open];
/** Files of the skills alice may see: refunds 2, acme-only 1, open-skill 1. */
const ALICE_FILE_COUNT = 4;
/** Every file of every skill: alice's four and admin-ops' two. */
const ALL_FILE_COUNT = 6;

/** Alice, bob, alice, bob...: who asks, and the skills only that principal may see. */
const alternating = (rounds: number) =>
  Array.from({ length: rounds }).flatMap(() => [
    { token: TOKENS.alice, expected: ALICE_SKILLS },
    { token: TOKENS.bob, expected: BOB_SKILLS },
  ]);

const ALTERNATION_ROWS = alternating(ALTERNATIONS / 2);
const ALTERNATING = alternating(CONCURRENT_LISTS / 2);

describe("skills isolation M4", () => {
  it("M4 two principals alternating on skills/list each see only their own skills", async () => {
    const seen = await listInTurn(
      makeSkillEnv(),
      ALTERNATION_ROWS.map(({ token }) => token),
    );
    assert.deepEqual(
      seen.map((skills) => skills.map(({ uri }) => uri)),
      ALTERNATION_ROWS.map(({ expected }) => expected),
    );
  });

  it("M4 50 concurrent lists by two principals never mix their skills", async () => {
    const env = makeSkillEnv();
    const lists = await Promise.all(ALTERNATING.map(({ token }) => listedSkillUris(env, token)));
    assert.deepEqual(
      lists,
      ALTERNATING.map(({ expected }) => expected),
    );
  });

  it("M4 a skill one principal was served is still refused to the next principal who lacks the scope", async () => {
    const env = makeSkillEnv();
    const served = await rpc(env, "skills/get", { uri: SKILL_URIS.refunds }, TOKENS.alice);
    const refused = await rpc(env, "skills/get", { uri: SKILL_URIS.refunds }, TOKENS.carol);
    const again = await rpc(env, "skills/get", { uri: SKILL_URIS.refunds }, TOKENS.alice);
    assert.deepEqual([served.status, refused.status, again.status], [200, 403, 200]);
    assert.equal(served.text, again.text);
  });

  it("M4 the only memo is the digest of the static bytes: it is the same for every principal", async () => {
    const env = makeSkillEnv();
    const [alice] = await listedSkills(env, TOKENS.alice);
    const [bob] = await listedSkills(env, TOKENS.bob);
    assert.deepEqual(alice?.resources, bob?.resources);
  });

  it("M4 each file is hashed once for the whole server, however many principals list", async (t) => {
    const digest = t.mock.method(crypto.subtle, "digest");
    const env = makeSkillEnv();
    await listInTurn(env, [TOKENS.alice, TOKENS.bob, TOKENS.alice, TOKENS.bob]);
    assert.equal(digest.mock.callCount(), ALICE_FILE_COUNT);
    await listedSkills(env, TOKENS.root);
    await listedSkills(env, TOKENS.alice);
    assert.equal(digest.mock.callCount(), ALL_FILE_COUNT);
  });

  it("M4 concurrent cold calls by different principals share one hashing of each file", async (t) => {
    const digest = t.mock.method(crypto.subtle, "digest");
    const env = makeSkillEnv();
    await Promise.all(ALTERNATING.map(({ token }) => listedSkills(env, token)));
    assert.equal(digest.mock.callCount(), ALICE_FILE_COUNT);
  });

  it("M4 a server that is built again hashes again: nothing is shared between servers", async (t) => {
    const digest = t.mock.method(crypto.subtle, "digest");
    await listedSkills(makeSkillEnv(), TOKENS.alice);
    await listedSkills(makeSkillEnv(), TOKENS.alice);
    assert.equal(digest.mock.callCount(), ALICE_FILE_COUNT * 2);
  });
});
