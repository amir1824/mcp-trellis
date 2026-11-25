/**
 * SCRUM-25 T4, R5 R8 R9 R10 R14 R15 R16 R17 R18 R19 R23: the documentation and constraint checks.
 * They pin SHAPE: headings, named surfaces and absent claims. Whether a claim is true is checked by review.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const RESOURCE_SOURCES = readdirSync(new URL("../../../src/mcp/resources/", import.meta.url))
  .map((name) => read(`src/mcp/resources/${name}`))
  .join("\n");

const apps = read("docs/mcp-apps.md");
const resources = read("docs/resources.md");
const reference = read("docs/reference.md");
const changelog = read("CHANGELOG.md");
const manifest = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies?: unknown;
  devDependencies?: Record<string, string>;
};

describe("R5 R9 R17 the MCP Apps comparison and the interoperability results", () => {
  it("R5 docs/mcp-apps.md compares the implementation with the named specification date", () => {
    assert.match(apps, /^## Specification comparison/m);
    assert.match(apps, /2026-01-26/);
  });

  it("R5 each spec point is listed with its level and what mcp-trellis does", () => {
    assert.match(apps, /\| Spec point \| Level in the spec \| mcp-trellis \|/);
    assert.match(apps, /frameDomains[\s\S]*Not supported/);
  });

  it("R9 R17 the interoperability table says no host was run and lists every host as not tested", () => {
    assert.match(apps, /^## Interoperability results/m);
    assert.match(apps, /No MCP Apps host was run for this release/);
    assert.match(apps, /basic-host[^\n]*Not tested/);
  });
});

describe("R8 R23 the example and the documented boundaries", () => {
  it("R8 the examples index lists the resources example and the test that boots it", () => {
    assert.match(
      read("examples/README.md"),
      /resources-app\.ts[^\n]*test\/resources-example\.test\.ts/,
    );
  });

  it("R23 docs/resources.md states a use case, who sees what and what is not included", () => {
    assert.match(resources, /Use one when/);
    assert.match(resources, /^## Who sees what/m);
    assert.match(resources, /^## What is not included/m);
  });

  it("R23 the docs name the tenant boundary and the audit value a host may switch on", () => {
    assert.match(resources, /Derive the tenant from `context`/);
    assert.match(resources, /resource_failed/);
  });
});

describe("R10 R14 R15 the constraints the slice keeps", () => {
  it("R10 no UI framework, bundler or component library is a dependency", () => {
    const names = Object.keys(manifest.devDependencies ?? {}).join(" ");
    assert.doesNotMatch(names, /react|vite|webpack|rollup|esbuild|parcel/);
  });

  it("R14 the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("R15 the resource code imports nothing from node:", () => {
    assert.doesNotMatch(RESOURCE_SOURCES, /from "node:/);
  });
});

describe("R16 R18 R19 budgets, migration and versioning", () => {
  it("R16 the budgets are still in the baselines document and the latency script measures resources", () => {
    const baselines = read("docs/modernization/baselines.md");
    assert.match(baselines, /at most 275,000 bytes/);
    assert.match(baselines, /at most 0\.5 ms/);
    assert.match(read("scripts/measure-baseline.mjs"), /"resources\/list"[\s\S]*"resources\/read"/);
  });

  it("R18 the reference has a migration note and the resources page a rollback", () => {
    assert.match(reference, /^### Migrating to resources/m);
    assert.match(resources, /^## Migration and rollback/m);
  });

  it("R19 the CHANGELOG calls the change additive and minor, under Unreleased, with a rollback line", () => {
    assert.match(
      changelog,
      /## \[Unreleased\][\s\S]*General resources \(additive, opt-in; a minor release\)/,
    );
    assert.match(changelog, /For resources, remove the `resources` option/);
  });
});

describe("R21 R22 the existing suites and the new tests are wired into the gate", () => {
  it("R21 npm test still runs the UI, 2026-07-28 and security suites that this change leaves unedited", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/ui\/\*\.test\.ts/);
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/modern\/\*\.test\.ts/);
    assert.match(manifest.scripts.test ?? "", /test\/security\/\*\.test\.ts/);
  });

  it("R22 the resource tests are part of npm test and of the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/resources\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/resources\/\*\.test\.ts/);
  });

  it("R22 build, lint, type-check and limits stay part of the release gate", () => {
    assert.match(
      manifest.scripts.prepublishOnly ?? "",
      /lint[\s\S]*typecheck[\s\S]*check:limits[\s\S]*npm test/,
    );
  });
});
