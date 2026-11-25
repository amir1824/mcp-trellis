import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMcpApp } from "../../../src/app.js";
import type { SkillDef } from "../../../src/mcp/skills/types.js";
import { type Ctx, makeEnv } from "../ui/harness.js";
import { makeSkillEnv, rpc, TOKENS } from "./harness.js";

const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NAME = 64;

const valid = (overrides: Record<string, unknown> = {}): SkillDef =>
  ({
    name: "good-skill",
    description: "Does good",
    instructions: "# Good\n",
    ...overrides,
  }) as SkillDef;

const withFile = (path: unknown, text: unknown = "x"): SkillDef =>
  valid({ files: [{ path, text }] });

const build = (...skills: SkillDef[]) => makeSkillEnv({ skills });

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/** The bytes of the SKILL.md that `valid()` generates. */
const VALID_SKILL_MD = '---\nname: "good-skill"\ndescription: "Does good"\n---\n\n# Good\n';

const BAD_NAMES = [
  ["an uppercase name", "Bad"],
  ["a leading hyphen", "-bad"],
  ["a trailing hyphen", "bad-"],
  ["consecutive hyphens", "bad--name"],
  ["an underscore", "bad_name"],
  ["a space", "bad name"],
  ["a slash", "bad/name"],
  ["a dot", "bad.name"],
  ["an empty name", ""],
  ["a name over 64 characters", "a".repeat(MAX_NAME + 1)],
  ["a non-ASCII name", "café"],
] as const;

const REJECTED: ReadonlyArray<[string, SkillDef[], RegExp]> = [
  ["a numeric name", [valid({ name: 7 })], /name must be 1 to 64/],
  ["a duplicate name", [valid(), valid()], /name is a duplicate/],
  ["an empty description", [valid({ description: " " })], /description must be 1 to 1024/],
  [
    "a description over 1024 characters",
    [valid({ description: "d".repeat(1025) })],
    /description must be 1 to 1024/,
  ],
  [
    "a control character in the description",
    [valid({ description: "line\nbreak" })],
    /control characters/,
  ],
  ["U+FFFE in the description", [valid({ description: "a\uFFFEb" })], /control characters/],
  ["U+FFFF in a metadata value", [valid({ metadata: { a: "x\uFFFF" } })], /metadata "a" must be/],
  ["U+10FFFF in the description", [valid({ description: "a\u{10FFFF}" })], /control characters/],
  ["U+FDD0 in the description", [valid({ description: "a\uFDD0" })], /control characters/],
  ["U+2028 in the description", [valid({ description: "a\u2028b" })], /control characters/],
  ["U+2029 in a metadata value", [valid({ metadata: { a: "x\u2029y" } })], /metadata "a" must be/],
  ["a lone surrogate in the instructions", [valid({ instructions: "\uD800" })], /well-formed/],
  ["numeric instructions", [valid({ instructions: 3 })], /instructions must be well-formed/],
  [
    "allowed-tools in metadata",
    [valid({ metadata: { "allowed-tools": "Bash" } })],
    /"allowed-tools" is not allowed/,
  ],
  [
    "a reserved metadata prefix",
    [valid({ metadata: { "io.modelcontextprotocol/x": "1" } })],
    /not allowed/,
  ],
  ["a non-string metadata value", [valid({ metadata: { a: 1 } })], /metadata "a" must be/],
  ["metadata that is not an object", [valid({ metadata: "x" })], /metadata must be an object/],
  ["a numeric scope", [valid({ scope: 3 })], /scope must be a string or null/],
  ["a string allow", [valid({ allow: "yes" })], /allow must be a function/],
  ["a non-array files", [valid({ files: {} })], /files must be an array/],
  ["a non-object entry", [null as unknown as SkillDef], /skills\[0\] must be an object/],
  ["a non-string file text", [withFile("a.md", 3)], /text must be well-formed/],
  [
    "an empty mimeType",
    [valid({ files: [{ path: "a.md", text: "x", mimeType: "" }] })],
    /mimeType/,
  ],
  [
    "the MCP Apps mime type",
    [valid({ files: [{ path: "a.md", text: "x", mimeType: "text/html;profile=mcp-app" }] })],
    /MCP Apps type/,
  ],
];

const BAD_PATHS = [
  ["a parent segment", "../x.md"],
  ["a parent segment in the middle", "a/../x.md"],
  ["a current-directory segment", "./x.md"],
  ["a lone dot", "."],
  ["a lone double dot", ".."],
  ["an empty segment", "a//x.md"],
  ["an absolute path", "/etc/passwd"],
  ["a trailing slash", "a/"],
  ["an empty path", ""],
  ["a percent sign", "a%2e%2e/x.md"],
  ["a backslash", "a\\x.md"],
  ["a NUL byte", "a\u0000.md"],
  ["a dotfile", ".hidden"],
  ["a colon", "c:/x.md"],
  ["a space", "a b.md"],
  ["a path over 200 characters", `${"a".repeat(201)}.md`],
  ["SKILL.md", "SKILL.md"],
  ["SKILL.md in another case", "skill.md"],
  ["a nested SKILL.md", "inner/SKILL.md"],
] as const;

describe("skills config R2 R6 R14 M3 M5", () => {
  describe("M5 R6 names", () => {
    for (const [label, name] of BAD_NAMES) {
      it(`M5 R6 construction rejects ${label}`, () => {
        assert.throws(() => build(valid({ name })), /name must be 1 to 64 lowercase/);
      });
    }

    it("R6 accepts a 64-character name", () => {
      assert.doesNotThrow(() => build(valid({ name: "a".repeat(MAX_NAME) })));
    });
  });

  describe("M5 construction rejects the rest", () => {
    for (const [label, skills, expected] of REJECTED) {
      it(`M5 construction rejects ${label}`, () => {
        assert.throws(() => build(...skills), expected);
      });
    }

    it("M5 lists every violation of every skill in one error and serves nothing", () => {
      assert.throws(
        () => build(valid({ name: "Bad", description: "" }), valid({ name: "ok", scope: 3 })),
        (error: Error) =>
          /invalid skills configuration/.test(error.message) &&
          /skills Bad: name must be/.test(error.message) &&
          /skills Bad: description must be/.test(error.message) &&
          /skills ok: scope must be/.test(error.message),
      );
    });

    it("M5 a skill over the limits and a bad name are listed together", () => {
      const tooMany = Array.from({ length: MAX_FILES }, (_, index) => ({
        path: `f${index}.md`,
        text: "x",
      }));
      assert.throws(
        () => build(valid({ name: "Bad" }), valid({ name: "big", files: tooMany })),
        (error: Error) =>
          /skills Bad: name must be/.test(error.message) &&
          /skills big: has 513 files, over the 512-file limit/.test(error.message),
      );
    });

    it("M5 rejects skills that is not an array", () => {
      assert.throws(() => makeSkillEnv({ skills: {} as unknown as SkillDef[] }), /not an array/);
    });

    it("M5 a skill:// uri in resources stops construction", () => {
      const resources = [{ uri: "skill://sneaky/SKILL.md", name: "S", read: () => "s" }];
      assert.throws(
        () => makeEnv({ options: { resources, skills: [valid()] } }),
        /"skill:\/\/", which skills owns/,
      );
    });
  });

  describe("M3 R6 file paths", () => {
    for (const [label, path] of BAD_PATHS) {
      it(`M3 R6 construction rejects ${label}`, () => {
        assert.throws(() => build(withFile(path)), /file path|collides with SKILL\.md/);
      });
    }

    it("M3 a duplicate path, also in another case, is refused", () => {
      const skill = valid({
        files: [
          { path: "a.md", text: "1" },
          { path: "A.md", text: "2" },
        ],
      });
      assert.throws(() => build(skill), /file path "A\.md" is a duplicate/);
    });

    it("M3 accepts nested relative paths of letters, digits, dots, hyphens and underscores", () => {
      assert.doesNotThrow(() => build(withFile("references/api_v2/guide-1.0.md")));
    });
  });

  describe("R6 limits", () => {
    const supporting = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ path: `f${index}.md`, text: "x" }));

    it("R6 accepts 512 files in a skill, SKILL.md included", () => {
      assert.doesNotThrow(() => build(valid({ files: supporting(MAX_FILES - 1) })));
    });

    it("R6 refuses 513 files in a skill", () => {
      assert.throws(() => build(valid({ files: supporting(MAX_FILES) })), /513 files/);
    });

    it("R6 accepts a skill of exactly 16 MiB", () => {
      const filler = "a".repeat(MAX_BYTES - bytesOf(VALID_SKILL_MD));
      assert.doesNotThrow(() => build(valid({ files: [{ path: "big.txt", text: filler }] })));
    });

    it("R6 counts bytes, not characters: 8 Mi two-byte characters and one more are over", () => {
      const text = "é".repeat(MAX_BYTES / 2);
      assert.throws(
        () => build(valid({ files: [{ path: "big.txt", text }] })),
        /bytes, over the 16777216-byte limit/,
      );
    });

    it("R6 the limit is per skill: two skills of 9 MiB are served", () => {
      const half = { path: "big.txt", text: "a".repeat(9 * 1024 * 1024) };
      assert.doesNotThrow(() =>
        build(valid({ name: "one", files: [half] }), valid({ name: "two", files: [half] })),
      );
    });
  });

  describe("R2 R14 the registration surface", () => {
    it("R2 a skill with only name, description and instructions is registered and listed", async () => {
      const reply = await rpc(build(valid()), "skills/list", undefined, TOKENS.alice);
      const { skills } = reply.body.result as { skills: Array<{ uri: string }> };
      assert.deepEqual(
        skills.map(({ uri }) => uri),
        ["skill://good-skill/SKILL.md"],
      );
    });

    it("R2 a later change to the host's object changes nothing that is served", async () => {
      const skill = valid({ files: [{ path: "a.md", text: "before" }] });
      const env = build(skill);
      skill.instructions = "changed";
      (skill.files ?? [])[0] = { path: "a.md", text: "changed" };
      const read = await rpc(
        env,
        "resources/read",
        { uri: "skill://good-skill/a.md" },
        TOKENS.alice,
      );
      assert.match(JSON.stringify(read.body.result), /before/);
    });

    it("R2 createMcpApp takes the same skills option and serves it", async () => {
      const app = createMcpApp<Ctx>({
        serverInfo: { name: "app-test", version: "1.0.0" },
        tools: [],
        skills: [valid()],
        allowInMemoryCodeStore: true,
        auth: {
          codeSecret: "app-test-code-secret-value-32-characters-long",
          resolveUser: async () => ({ id: "u1" }),
          loginUrl: () => "/login",
          mintAccessToken: async () => ({ accessToken: "t", expiresIn: 3600 }),
          verifyToken: async () => ({
            userId: "u1",
            scopes: ["mcp"],
            audience: "https://app.test/mcp",
          }),
        },
      });
      const response = await app.fetch(
        new Request("https://app.test/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "skills/list" }),
        }),
      );
      assert.match(await response.text(), /skill:\/\/good-skill\/SKILL\.md/);
    });

    it("R2 R14 a skill with no scope on a multi-scope createMcpApp is refused, like a tool", () => {
      assert.throws(
        () =>
          createMcpApp<Ctx>({
            serverInfo: { name: "app-test", version: "1.0.0" },
            tools: [],
            scopes: ["read", "write"],
            defaultScopes: ["read"],
            skills: [valid()],
            allowInMemoryCodeStore: true,
            auth: {
              codeSecret: "app-test-code-secret-value-32-characters-long",
              resolveUser: async () => ({ id: "u1" }),
              loginUrl: () => "/login",
              mintAccessToken: async () => ({ accessToken: "t", expiresIn: 3600 }),
              verifyToken: async () => null,
            },
          }),
        /these skills have no scope.*good-skill/s,
      );
    });
  });
});
