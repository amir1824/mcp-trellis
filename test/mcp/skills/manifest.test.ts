import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it, mock } from "node:test";
import type { SkillDef } from "../../../src/mcp/skills/types.js";
import { json, modern } from "../modern/harness.js";
import {
  listedSkills,
  makeSkillEnv,
  POLICY_TEXT,
  parseFrontmatter,
  REFUNDS_DESCRIPTION,
  rpc,
  SKILL_URIS,
  sendCall,
  TOKENS,
} from "./harness.js";

const DIGEST_FORMAT = /^sha256:[0-9a-f]{64}$/;

/** The supporting files of the specification's worked example, with the size and digest it publishes. */
const SPEC_VECTORS = [
  [
    "invoice.md",
    "# Invoice\n\nCustomer:\nAmount:\n",
    29,
    "61f4ea6d2c75fde1b4977219e7e3107d491c3c26aefb6686e84d6281c088d9ee",
  ],
  [
    "purchase-order.md",
    "# Purchase order\n\nSupplier:\nItems:\n",
    35,
    "f2ff774b1737ff3dec81c47946f9976f18a1a9f69dda0a81f22eabd95173c158",
  ],
  [
    "credit-note.md",
    "# Credit note\n\nInvoice:\nCredit amount:\n",
    39,
    "766bffa8d4908ce897e1727ca22e4bf0fa796620b35218ce2132a124545626f1",
  ],
] as const;

const PDF: SkillDef = {
  name: "pdf-processing",
  description: "Extract, fill, and assemble PDF documents",
  instructions: "# PDF processing\n\nChoose the matching template from `templates/`.\n",
  files: SPEC_VECTORS.map(([path, text]) => ({ path: `templates/${path}`, text })),
};

const QUOTED: SkillDef = {
  name: "quoted",
  description: 'He said "hi": it\'s café, 100 € \\ done',
  instructions: "# Q\n",
  metadata: { "key with: colon": 'v"1', owner: "équipe" },
};

const sha256 = (text: string): string =>
  `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const textOf = async (env: ReturnType<typeof makeSkillEnv>, uri: string, token: string) => {
  const reply = await rpc(env, "resources/read", { uri }, token);
  return (reply.body.result as { contents: Array<{ text: string }> }).contents[0]?.text ?? "";
};

describe("skills manifest R5", () => {
  it("R5 each supporting file carries the size and digest the specification publishes for it", async () => {
    const [entry] = await listedSkills(makeSkillEnv({ skills: [PDF] }), TOKENS.alice);
    const listed = entry?.resources.slice(1).map(({ size, digest }) => [size, digest]);
    assert.deepEqual(
      listed,
      SPEC_VECTORS.map(([, , size, hex]) => [size, `sha256:${hex}`]),
    );
  });

  it("R5 the SKILL.md entry is first, uses the sha256:<64 hex> form and is the skill's own URI", async () => {
    const [entry] = await listedSkills(makeSkillEnv({ skills: [PDF] }), TOKENS.alice);
    assert.equal(entry?.resources[0]?.uri, entry?.uri);
    assert.match(entry?.resources[0]?.digest ?? "", DIGEST_FORMAT);
  });

  it("R5 every digest and size is computed from the bytes that resources/read serves", async () => {
    const env = makeSkillEnv();
    const [entry] = await listedSkills(env, TOKENS.alice);
    const served = await Promise.all(
      (entry?.resources ?? []).map(async ({ uri }) => textOf(env, uri, TOKENS.alice)),
    );
    assert.deepEqual(
      entry?.resources.map(({ digest, size }) => [digest, size]),
      served.map((text) => [sha256(text), Buffer.byteLength(text, "utf8")]),
    );
  });

  it("R5 size counts UTF-8 bytes, not characters: the accented file is longer in bytes", async () => {
    const [entry] = await listedSkills(makeSkillEnv(), TOKENS.alice);
    const policy = entry?.resources.find(({ uri }) => uri === SKILL_URIS.refundsPolicy);
    assert.equal(policy?.size, Buffer.byteLength(POLICY_TEXT, "utf8"));
    assert.notEqual(policy?.size, POLICY_TEXT.length);
  });

  it("R5 resources is complete: SKILL.md and every file, each once, in registration order", async () => {
    const [entry] = await listedSkills(makeSkillEnv(), TOKENS.alice);
    assert.deepEqual(
      entry?.resources.map(({ uri }) => uri),
      [SKILL_URIS.refunds, SKILL_URIS.refundsPolicy],
    );
  });

  it("R5 the frontmatter of the entry equals the frontmatter of the SKILL.md that is served", async () => {
    const env = makeSkillEnv();
    const [entry] = await listedSkills(env, TOKENS.alice);
    const parsed = parseFrontmatter(await textOf(env, SKILL_URIS.refunds, TOKENS.alice));
    assert.deepEqual(parsed, entry?.frontmatter);
    assert.deepEqual(entry?.frontmatter, {
      name: "refunds",
      description: REFUNDS_DESCRIPTION,
      metadata: { owner: "billing" },
    });
  });

  it("R5 quotes, colons, backslashes and accents survive the round trip from entry to SKILL.md", async () => {
    const env = makeSkillEnv({ skills: [QUOTED] });
    const [entry] = await listedSkills(env, TOKENS.alice);
    const parsed = parseFrontmatter(await textOf(env, "skill://quoted/SKILL.md", TOKENS.alice));
    assert.deepEqual(parsed, entry?.frontmatter);
    assert.equal(parsed.description, QUOTED.description);
  });

  it("R5 name and description come first in SKILL.md, and the body follows the closing line", async () => {
    const text = await textOf(makeSkillEnv(), SKILL_URIS.refunds, TOKENS.alice);
    assert.match(
      text,
      /^---\nname: "refunds"\ndescription: ".*"\nmetadata: \{.*\}\n---\n\n# Refunds\n/s,
    );
  });

  it("R5 skills/get returns the same entry as skills/list, on both protocol paths", async () => {
    const env = makeSkillEnv();
    const [listed] = await listedSkills(env, TOKENS.alice);
    const legacy = await rpc(env, "skills/get", { uri: SKILL_URIS.refunds }, TOKENS.alice);
    const modernReply = await json<{ result: { skill: unknown } }>(
      await sendCall(env, modern("skills/get", { uri: SKILL_URIS.refunds }, TOKENS.alice)),
    );
    assert.deepEqual((legacy.body.result as { skill: unknown }).skill, listed);
    assert.deepEqual(modernReply.result.skill, listed);
  });

  it("R5 the digest changes with one byte of the file: two skills that differ in one file differ in one digest", async () => {
    const edited: SkillDef = {
      ...PDF,
      files: [
        { path: "templates/invoice.md", text: `${SPEC_VECTORS[0][1]}x` },
        ...(PDF.files?.slice(1) ?? []),
      ],
    };
    const [before] = await listedSkills(makeSkillEnv({ skills: [PDF] }), TOKENS.alice);
    const [after] = await listedSkills(makeSkillEnv({ skills: [edited] }), TOKENS.alice);
    const differing = before?.resources.filter(
      ({ digest }, index) => digest !== after?.resources[index]?.digest,
    );
    assert.deepEqual(
      differing?.map(({ uri }) => uri),
      ["skill://pdf-processing/templates/invoice.md"],
    );
  });

  it("a failed hash is retried on the next call, never kept", async () => {
    const digest = mock.method(
      globalThis.crypto.subtle,
      "digest",
      async () => {
        throw new Error("digest unavailable");
      },
      { times: 1 },
    );
    const env = makeSkillEnv({ skills: [PDF] });
    const failed = await rpc(env, "skills/list", undefined, TOKENS.alice);
    const [entry] = await listedSkills(env, TOKENS.alice);
    digest.mock.restore();
    assert.equal(failed.status, 500);
    assert.match(entry?.resources[0]?.digest ?? "", DIGEST_FORMAT);
  });
});
