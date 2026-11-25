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

describe("skills documentation", () => {
  it("docs/skills.md keeps the headings other docs link to", () => {
    assert.match(skills, /^## Status/m);
    assert.match(skills, /^## Limits/m);
    assert.match(skills, /^## What is not included/m);
    assert.match(skills, /^## Migration and rollback/m);
  });

  it("the reference has the skills migration section", () => {
    assert.match(reference, /^### Migrating to skills/m);
  });

  it("the README links to docs/skills.md", () => {
    assert.match(read("README.md"), /\[docs\/skills\.md\]\(docs\/skills\.md\)/);
  });

  it("the CHANGELOG has a skills entry with its rollback line", () => {
    assert.match(changelog, /Experimental Skills over MCP \(additive, opt-in; a minor release\)/);
    assert.match(changelog, /For skills, remove the `skills` option/);
  });
});

describe("skills constraints", () => {
  it("the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("the skills code imports nothing from node: and hashes with Web Crypto", () => {
    assert.doesNotMatch(SKILL_SOURCES, /from "node:/);
    assert.match(SKILL_SOURCES, /crypto\.subtle\.digest\("SHA-256"/);
  });

  it("the skills tests are part of npm test and of the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/skills\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/skills\/\*\.test\.ts/);
  });

  it("the option is @experimental and lives in its own folder", () => {
    assert.match(read("src/mcp/types.ts"), /@experimental Skills over MCP/);
    assert.match(read("src/app-options.ts"), /@experimental Skills over MCP/);
    assert.match(read("src/mcp/skills/types.ts"), /@experimental/);
    assert.ok(SKILL_FILES.length <= MAX_FILES_PER_FOLDER);
  });

  it("the stable method tables only gain skills/* through a separate tier", () => {
    assert.match(read("src/mcp/rpc-handlers.ts"), /withSkills: SKILL_TIER_METHODS/);
  });

  it("the skills code neither imports the tool registry nor calls a tool or a handler", () => {
    assert.doesNotMatch(
      SKILL_SOURCES,
      /registry\.js|"tools\/call"|\.handler\(|\bfetch\(|eval\(|new Function/,
    );
  });

  it("the contract is one SkillDef and one index, with no plugin or registry abstraction", () => {
    const types = read("src/mcp/skills/types.ts");
    assert.match(types, /export type SkillDef = /);
    assert.match(types, /export type SkillIndex = /);
    assert.doesNotMatch(SKILL_SOURCES, /plugin|Registry|register[A-Z]/);
  });
});
