import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const RESOURCE_SOURCES = readdirSync(new URL("../../../src/mcp/resources/", import.meta.url))
  .map((name) => read(`src/mcp/resources/${name}`))
  .join("\n");

const resources = read("docs/resources.md");
const manifest = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: unknown;
  devDependencies?: Record<string, string>;
};

describe("resources documentation", () => {
  it("docs/resources.md keeps the headings other docs link to", () => {
    assert.match(resources, /^## A resource/m);
    assert.match(resources, /^## Who sees what/m);
    assert.match(resources, /^## What is not included/m);
    assert.match(resources, /^## Migration and rollback/m);
  });

  it("the reference has the resources migration section", () => {
    assert.match(read("docs/reference.md"), /^### Migrating to resources/m);
  });

  it("the examples index lists the resources example and the test that boots it", () => {
    assert.match(
      read("examples/README.md"),
      /resources-app\.ts[^\n]*test\/resources-example\.test\.ts/,
    );
  });

  it("the CHANGELOG has a resources entry with its rollback line", () => {
    const changelog = read("CHANGELOG.md");
    assert.match(changelog, /General resources \(additive, opt-in; a minor release\)/);
    assert.match(changelog, /For resources, remove the `resources` option/);
  });
});

describe("resources constraints", () => {
  it("no UI framework, bundler or component library is a dependency", () => {
    const names = Object.keys(manifest.devDependencies ?? {}).join(" ");
    assert.doesNotMatch(names, /react|vite|webpack|rollup|esbuild|parcel/);
  });

  it("the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("the resource code imports nothing from node:", () => {
    assert.doesNotMatch(RESOURCE_SOURCES, /from "node:/);
  });
});

describe("resources test wiring", () => {
  it("the resource tests run in npm test and in the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/resources\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/resources\/\*\.test\.ts/);
  });

  it("the UI, 2026-07-28 and security suites run in npm test", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/ui\/\*\.test\.ts/);
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/modern\/\*\.test\.ts/);
    assert.match(manifest.scripts.test ?? "", /test\/security\/\*\.test\.ts/);
  });

  it("build, lint, type-check and limits stay part of the release gate", () => {
    assert.match(
      manifest.scripts.prepublishOnly ?? "",
      /lint[\s\S]*typecheck[\s\S]*check:limits[\s\S]*npm test/,
    );
  });
});
