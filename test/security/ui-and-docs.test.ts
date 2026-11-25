/**
 * SCRUM-25 T3, R14 and the documentation and constraint checks (R1 R6 R15 R18 to R26, M5 M6).
 * The document checks pin SHAPE: headings, named surfaces and absent claims. Whether a claim in them
 * is true is checked by review against the source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { callTool, makeEnv, TOKENS } from "../mcp/ui/harness.js";

const read = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const security = read("docs/security.md");
const review = read("docs/modernization/oauth-cimd-review.md");
const reference = read("docs/reference.md");
const changelog = read("CHANGELOG.md");
const matrix = read("docs/modernization/capability-matrix.md");
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

describe("R1 R6 R15 R17 the review, the threat model and the boundary are written down", () => {
  it("R1 the review document names OAuth, CIMD and the decisions it leaves open", () => {
    assert.match(review, /^## OAuth/m);
    assert.match(review, /^## CIMD/m);
    assert.match(review, /^## Deviations and what was left as it is/m);
    assert.match(review, /code_challenge_method/);
  });

  it("R6 docs/security.md states the boundary with application-level tenant isolation", () => {
    assert.match(
      security,
      /^## Tenant isolation: what Trellis does and what the application does/m,
    );
    assert.match(security, /Derives the tenant in `context` from `principal`/);
  });

  it("R6 docs/security.md no longer says the server offers tools only", () => {
    assert.doesNotMatch(security, /Tools only — no `resources\/\*`/);
  });

  it("R15 R17 docs/security.md carries the caches and shared-state table and a restrictive profile", () => {
    assert.match(security, /^### Caches and shared state/m);
    assert.match(security, /^### Restrictive profile/m);
    assert.match(security, /hideToolsOutsideScope: "strict"/);
  });

  it("R15 the security suite is part of npm test and of the coverage run", () => {
    assert.match(manifest.scripts.test ?? "", /test\/security\/\*\.test\.ts/);
    assert.match(read("scripts/test-coverage.mjs"), /test\/security\/\*\.test\.ts/);
  });
});

describe("R18 to R26 M5 M6 the constraints the slice keeps", () => {
  it("R18 the package still has no runtime dependency", () => {
    assert.equal(manifest.dependencies, undefined);
  });

  it("R19 M5 every new option is documented as optional and off by default", () => {
    assert.match(reference, /`cimdAllowedPorts`/);
    assert.match(reference, /`cimdRequireJsonContentType`/);
    assert.match(reference, /`cimdFetch`/);
    assert.match(reference, /No change is required for an existing integration/);
  });

  it("R20 the new CIMD option code imports nothing from node:", () => {
    const files = ["options", "url-guard", "cimd"].map((name) => read(`src/oauth/cimd/${name}.ts`));
    assert.doesNotMatch(files.join("\n"), /from "node:/);
  });

  it("R21 the budgets this change is measured against are still in the baselines document", () => {
    const baselines = read("docs/modernization/baselines.md");
    assert.match(baselines, /at most 275,000 bytes/);
    assert.match(baselines, /at most 0\.5 ms/);
  });

  it("R22 the CHANGELOG has an Unreleased entry for this slice", () => {
    assert.match(changelog, /## \[?Unreleased\]?[\s\S]*cimdAllowedPorts/);
  });

  it("R23 the matrix gives resources, Skills and the reference app to later slices", () => {
    assert.match(matrix, /T4 Resources & MCP Apps/);
    assert.match(matrix, /T5/);
  });

  it("R24 the review document justifies each new public option", () => {
    assert.match(review, /^## New public options/m);
  });

  it("R25 the CHANGELOG labels the change a minor-version change", () => {
    assert.match(changelog, /minor/i);
  });

  it("R26 the release notes carry a rollback line and the reference a migration note", () => {
    assert.match(changelog, /Rollback/);
    assert.match(reference, /Migrating to the CIMD hardening options/);
  });

  it("M6 the public docs carry no exploit steps or proof of concept", () => {
    assert.doesNotMatch(security + review, /exploit|proof[- ]of[- ]concept|\bPoC\b/i);
  });
});
