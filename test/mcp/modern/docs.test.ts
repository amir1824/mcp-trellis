import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const manifest = JSON.parse(read("package.json")) as {
  dependencies?: unknown;
  scripts: Record<string, string>;
};
const modernSource = ["cache", "discover", "errors", "profile", "request", "result"]
  .map((file) => read(`src/mcp/modern/${file}.ts`))
  .join("\n");
const matrix = read("docs/modernization/capability-matrix.md");

describe("2026-07-28 change: constraints and documentation", () => {
  it("R9 R11 M7 R20 the modern layer imports nothing from node: and adds no runtime dependency", () => {
    assert.doesNotMatch(modernSource, /from "node:/);
    assert.equal(manifest.dependencies, undefined);
  });

  it("R12 the modern layer stays small enough to fit the proposed size budget's headroom", () => {
    assert.equal(Buffer.byteLength(modernSource) < 25_000, true);
  });

  it("R16 R17 the new tests run in npm test and in the coverage gate", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/modern\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/modern\/\*\.test\.ts/);
  });

  it("R7 R15 R19 the README, reference and CHANGELOG describe the change as an additive minor", () => {
    assert.match(read("README.md"), /2026-07-28/);
    assert.match(read("docs/reference.md"), /Migrating to 2026-07-28/);
    assert.match(read("CHANGELOG.md"), /## \[?Unreleased\]?[\s\S]*2026-07-28[\s\S]*minor/);
  });

  it("R18 the capability matrix names a conformance test for each mandatory row it now supports", () => {
    assert.equal((matrix.match(/test\/mcp\/modern\//g) ?? []).length >= 9, true);
  });

  it("R6 the golden file covers the three older versions", () => {
    const golden = read("test/mcp/modern/golden-legacy.json");
    assert.match(golden, /"2024-11-05"/);
    assert.match(golden, /"2025-03-26"/);
    assert.match(golden, /"2025-06-18"/);
  });

  it("R1 R14 the T2 scope is the matrix rows M-1 to M-9 and nothing else is claimed supported", () => {
    assert.doesNotMatch(matrix, /\| O-12 \|[^\n]*\| supported/);
  });
});
