import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpApp } from "../../src/app.js";
import { encodeToken } from "../fixtures/your-app.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "https://example.test";

/** Same section/fence extraction as `scripts/check-quickstart.mjs`. */
const readQuickstartFence = async (): Promise<string> => {
  const readme = await readFile(join(ROOT, "README.md"), "utf8");
  const section = readme.match(/## The 30-second example\n([\s\S]*?)(?=\n## |\n$)/)?.[1];
  const fence = section?.match(/```ts\n([\s\S]*?)```/)?.[1];
  assert.ok(fence, "README is missing the 30-second example ts fence");
  return fence;
};

const rewriteImports = (source: string): string =>
  source
    .replace(/from "mcp-trellis"/g, `from "${pathToFileURL(join(ROOT, "src/server.ts")).href}"`)
    .replace(
      /from "\.\/your-app\.js"/g,
      `from "${pathToFileURL(join(ROOT, "test/fixtures/your-app.ts")).href}"`,
    );

describe("README 30-second example runs as written", () => {
  let dir: string;
  let mcp: McpApp;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-trellis-readme-"));
    const file = join(dir, "quickstart.mts");
    await writeFile(file, rewriteImports(await readQuickstartFence()));
    ({ mcp } = (await import(pathToFileURL(file).href)) as { mcp: McpApp });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rpc = (method: string, params?: Record<string, unknown>, token?: string) =>
    mcp.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      }),
    );

  const aliceToken = encodeToken({ userId: "alice", scopes: ["mcp"], audience: `${ORIGIN}/mcp` });

  it("answers initialize without a token", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(res.status, 200);
  });

  it("lists list_my_projects", async () => {
    const res = await rpc("tools/list", undefined, aliceToken);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(
      body.result.tools.map((tool) => tool.name),
      ["list_my_projects"],
    );
  });

  it("returns the signed-in user's projects from tools/call", async () => {
    const res = await rpc("tools/call", { name: "list_my_projects", arguments: {} }, aliceToken);
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    assert.deepEqual(JSON.parse(body.result.content[0]?.text ?? ""), ["Apollo", "Borealis"]);
  });
});
