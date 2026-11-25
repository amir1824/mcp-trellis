import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { callTool, makeEnv, TOKENS } from "../mcp/ui/harness.js";

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const security = read("docs/security.md");
const reference = read("docs/reference.md");
const changelog = read("CHANGELOG.md");
const manifest = JSON.parse(read("package.json")) as {
  dependencies?: unknown;
  scripts: Record<string, string>;
};

describe("R14 a call that comes from an MCP App is a plain tool call with the same checks", () => {
  it("R14 an app-only tool is refused without its scope, and its handler never runs", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "refresh_products", TOKENS.alice, { category: "x" });
    assert.equal(reply.status, 403);
    assert.deepEqual(env.contexts, []);
  });

  it("R14 visibility is not an access rule: a caller with the scope can call an app-only tool directly", async () => {
    const env = makeEnv();
    const reply = await callTool(env, "refresh_products", TOKENS.carol, { category: "books" });
    assert.equal(reply.status, 200);
  });

  it("R14 a tool that needs a scope nobody in the app holds is refused for every caller who lacks it", async () => {
    const env = makeEnv();
    const replies = await Promise.all(
      [TOKENS.alice, TOKENS.bob, TOKENS.carol, TOKENS.eve].map((token) =>
        callTool(env, "admin_report", token),
      ),
    );
    assert.deepEqual(
      replies.map((reply) => reply.status),
      [403, 403, 403, 403],
    );
  });
});

describe("security documentation", () => {
  it("docs/security.md states the boundary with application-level tenant isolation", () => {
    assert.match(
      security,
      /^## Tenant isolation: what Trellis does and what the application does/m,
    );
  });

  it("docs/security.md has the caches table and the restrictive profile that names a real option", () => {
    assert.match(security, /^### Caches and shared state/m);
    assert.match(security, /^### Restrictive profile/m);
    assert.match(security, /hideToolsOutsideScope: "strict"/);
    assert.match(read("src/app-options.ts"), /hideToolsOutsideScope\?: boolean \| "strict"/);
  });

  it("the security suite runs in npm test and in the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/security\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/security\/\*\.test\.ts/);
  });
});

describe("security constraints and documented options", () => {
  it("the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("the CIMD options the reference documents exist in the source", () => {
    const options = read("src/oauth/cimd/options.ts");
    assert.match(reference, /`cimdAllowedPorts`/);
    assert.match(reference, /`cimdRequireJsonContentType`/);
    assert.match(reference, /`cimdFetch`/);
    assert.match(options, /cimdAllowedPorts/);
    assert.match(options, /cimdRequireJsonContentType/);
    assert.match(options, /cimdFetch/);
  });

  it("the CIMD option code imports nothing from node:", () => {
    const files = ["options", "url-guard", "cimd"].map((name) => read(`src/oauth/cimd/${name}.ts`));
    assert.doesNotMatch(files.join("\n"), /from "node:/);
  });

  it("the reference has the CIMD migration section", () => {
    assert.match(reference, /^### Migrating to the CIMD hardening options/m);
  });

  it("the CHANGELOG has an entry for the CIMD options", () => {
    assert.match(changelog, /cimdAllowedPorts/);
  });
});
