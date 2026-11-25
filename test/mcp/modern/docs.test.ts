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

describe("2026-07-28 layer: constraints and documentation links", () => {
  it("the modern layer imports nothing from node: and adds no runtime dependency", () => {
    assert.doesNotMatch(modernSource, /from "node:/);
    assert.equal(manifest.dependencies, undefined);
  });

  it("the modern layer stays small", () => {
    assert.equal(Buffer.byteLength(modernSource) < 25_000, true);
  });

  it("the modern tests run in npm test and in the coverage gate", () => {
    assert.match(manifest.scripts.test ?? "", /test\/mcp\/modern\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/mcp\/modern\/\*\.test\.ts/);
  });

  it("the reference keeps its 2026-07-28 migration section", () => {
    assert.match(read("docs/reference.md"), /^### Migrating to 2026-07-28/m);
  });

  it("the golden file covers the three older versions", () => {
    const golden = read("test/mcp/modern/golden-legacy.json");
    assert.match(golden, /"2024-11-05"/);
    assert.match(golden, /"2025-03-26"/);
    assert.match(golden, /"2025-06-18"/);
  });
});
