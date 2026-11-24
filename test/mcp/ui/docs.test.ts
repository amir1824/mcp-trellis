import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFile(join(ROOT, path), "utf8");

describe("R8 documentation", () => {
  it("R8 the README has a concise MCP Apps quickstart with the ext-apps snippet labelled illustrative", async () => {
    const readme = await read("README.md");
    const section =
      readme.match(/## Attach a UI to a tool \(MCP Apps\)\n([\s\S]*?)(?=\n## )/)?.[1] ?? "";
    assert.match(section, /uiResources/);
    assert.match(section, /@modelcontextprotocol\/ext-apps/);
    assert.match(section, /ontoolresult/);
    assert.match(section, /callServerTool/);
    assert.match(section, /illustrative/);
    assert.ok(section.split("\n").length < 60);
  });

  it("R8 the README and docs/mcp-apps.md state the host compatibility limits", async () => {
    const pages = [await read("README.md"), await read("docs/mcp-apps.md")];
    const limits = [
      /support varies by host/,
      /2025-06-18/,
      /enforces?/,
      /per-client negotiation/,
      /tenant/,
    ];
    const missing = limits.filter((limit) => pages.some((page) => !limit.test(page)));
    assert.deepEqual(missing, []);
    assert.match(pages[1] ?? "", /no real host/);
  });

  it("R8 the CHANGELOG has a 3.4.0 entry for MCP Apps", async () => {
    const changelog = await read("CHANGELOG.md");
    assert.match(changelog, /## \[3\.4\.0\] - \d{4}-\d{2}-\d{2}\n\n### Added\n\n- \*\*MCP Apps/);
  });
});
