/**
 * SCRUM-25 T5, R1 R8 R10 R12 R13 R14: the documentation and constraint checks. They pin SHAPE: headings,
 * the pinned text, named surfaces and absent claims. Whether a claim is true is checked by review.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const SKILL_FILES = readdirSync(new URL("../../../src/mcp/skills/", import.meta.url));
const SKILL_SOURCES = SKILL_FILES.map((name) => read(`src/mcp/skills/${name}`)).join("\n");

const skills = read("docs/skills.md");
const reference = read("docs/reference.md");
const changelog = read("CHANGELOG.md");
const manifest = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: unknown;
};

const MAX_FILES_PER_FOLDER = 8;

describe("R1 the specification is pinned before any code", () => {
  it("R1 docs/skills.md records the repository commit, the sha256 of skills.mdx and its path", () => {
    assert.match(skills, /^## Pinned specification/m);
    assert.match(skills, /c0705f9071caa539eeb2c9f5f2f77ac16b048ca6/);
    assert.match(skills, /6e33a33762783a02dc4c13c889dda5b8d7c525649012cf77da12d80c04ce6851/);
    assert.match(skills, /specification\/beta\/skills\.mdx/);
  });

  it("R1 it names the SEP, both status wordings and the two disagreements", () => {
    assert.match(skills, /SEP-2640/);
    assert.match(skills, /"Final"/);
    assert.match(skills, /Beta, destination not yet stated/);
    assert.match(skills, /^- \*\*Status\.\*\*/m);
    assert.match(skills, /^- \*\*Cache fields on `skills\/get`\.\*\*/m);
  });

  it("R1 it records the Agent Skills naming rule and its source", () => {
    assert.match(skills, /agentskills\.io\/specification/);
    assert.match(skills, /1 to 64 characters, lowercase letters, digits and hyphens/);
  });
});

describe("R8 experimental status, hosts tested and limitations", () => {
  it("R8 docs/skills.md says experimental and opt-in, and has the sections a reader needs", () => {
    assert.match(skills, /^## Status/m);
    assert.match(skills, /\*\*Experimental, opt-in and off by default\.\*\*/);
    assert.match(skills, /^## Limits/m);
    assert.match(skills, /^## What is not included/m);
    assert.match(skills, /^## Migration and rollback/m);
  });

  it("R8 it says no Skills host was tested and claims no tested host", () => {
    assert.match(skills, /^## Hosts tested/m);
    assert.match(skills, /No Skills host was tested/);
    assert.doesNotMatch(skills, /tested (with|against|on) (Claude|ChatGPT|Cursor|VS Code|Codex)/i);
  });

  it("R8 it states the limits and the unsupported parts of the specification", () => {
    assert.match(skills, /\| Files per skill, `SKILL\.md` included \| 512 \|/);
    assert.match(skills, /16 MiB/);
    assert.match(skills, /nested skills/);
    assert.match(skills, /`resources\/directory\/read`/);
  });

  it("R8 the reference, the README and the CHANGELOG point at it", () => {
    assert.match(reference, /^### Migrating to skills/m);
    assert.match(reference, /\| `skills\/list`, `skills\/get` \| Bearer \|/);
    assert.match(read("README.md"), /\[docs\/skills\.md\]\(docs\/skills\.md\)/);
    assert.match(
      changelog,
      /## \[Unreleased\][\s\S]*Experimental Skills over MCP \(additive, opt-in; a minor release\)/,
    );
    assert.match(changelog, /For skills, remove the `skills` option/);
  });

  it("R8 the capability matrix has the Skills rows and keeps the experimental status", () => {
    const matrix = read("docs/modernization/capability-matrix.md");
    assert.match(matrix, /^\| K-1 \|.*supported in T5/m);
    assert.match(matrix, /^\| Skills over MCP .*`experimental`/m);
  });
});

describe("R10 R12 R13 R14 the constraints the slice keeps", () => {
  it("R10 the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("R10 the skills code imports nothing from node: and hashes with Web Crypto", () => {
    assert.doesNotMatch(SKILL_SOURCES, /from "node:/);
    assert.match(SKILL_SOURCES, /crypto\.subtle\.digest\("SHA-256"/);
  });

  it("R10 the skills tests are part of npm test and of the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/skills\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/skills\/\*\.test\.ts/);
  });

  it("R10 the latency script measures skills/list and skills/get with 20 skills and the cold call", () => {
    const script = read("scripts/measure-baseline.mjs");
    assert.match(script, /"skills\/list"[\s\S]*"skills\/get"/);
    assert.match(script, /SKILL_COUNT = 20/);
    assert.match(script, /coldFirstCall/);
  });

  it("R12 the option is @experimental and lives in its own folder", () => {
    assert.match(read("src/mcp/types.ts"), /@experimental Skills over MCP/);
    assert.match(read("src/app-options.ts"), /@experimental Skills over MCP/);
    assert.match(read("src/mcp/skills/types.ts"), /@experimental/);
    assert.ok(SKILL_FILES.length <= MAX_FILES_PER_FOLDER);
  });

  it("R12 the stable method tables only gain skills/* through a separate tier", () => {
    assert.match(read("src/mcp/rpc-handlers.ts"), /withSkills: SKILL_TIER_METHODS/);
  });

  it("R13 the skills code neither imports the tool registry nor calls a tool or a handler", () => {
    assert.doesNotMatch(
      SKILL_SOURCES,
      /registry\.js|"tools\/call"|\.handler\(|\bfetch\(|eval\(|new Function/,
    );
  });

  it("R14 the contract is one SkillDef and one index, with no plugin or registry abstraction", () => {
    const types = read("src/mcp/skills/types.ts");
    assert.match(types, /export type SkillDef = /);
    assert.match(types, /export type SkillIndex = /);
    assert.doesNotMatch(SKILL_SOURCES, /plugin|Registry|register[A-Z]/);
  });
});
