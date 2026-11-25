import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");

describe("MCP Apps documentation", () => {
  it("the README has the MCP Apps section and uses the documented option", async () => {
    const readme = await read("README.md");
    const section =
      readme.match(/## Tool UIs, resources and skills\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
    assert.match(section, /uiResources/);
  });

  it("docs/mcp-apps.md keeps the headings other docs link to", async () => {
    const page = await read("docs/mcp-apps.md");
    assert.match(page, /^## Setup/m);
    assert.match(page, /^### CSP/m);
    assert.match(page, /^## Host compatibility and limits/m);
  });

  it("the CHANGELOG has a 3.4.0 entry for MCP Apps", async () => {
    const changelog = await read("CHANGELOG.md");
    assert.match(changelog, /## \[3\.4\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- \*\*MCP Apps/);
  });
});
