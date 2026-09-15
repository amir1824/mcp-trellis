#!/usr/bin/env node
/**
 * `npm run test:coverage` on every supported Node. The threshold flags
 * (--test-coverage-lines / --test-coverage-branches) exist only from Node 22,
 * so older runtimes report coverage without enforcing it; CI enforces on 22.
 */
import { spawnSync } from "node:child_process";

const THRESHOLDS = ["--test-coverage-lines=94", "--test-coverage-branches=88"];
const TEST_GLOBS = [
  "test/oauth/**/*.test.ts",
  "test/mcp/*.test.ts",
  "test/adapters/*.test.ts",
  "test/auth/*.test.ts",
  "test/util/*.test.ts",
  "test/*.test.ts",
];

const major = Number(process.versions.node.split(".")[0]);
const enforce = major >= 22;
if (!enforce) {
  console.warn(
    `test-coverage: Node ${process.versions.node} lacks coverage threshold flags — ` +
      "reporting only. Thresholds are enforced in CI on Node 22.",
  );
}

const args = [
  "--import",
  "tsx",
  "--test",
  "--experimental-test-coverage",
  ...(enforce ? THRESHOLDS : []),
  "--enable-source-maps",
  ...TEST_GLOBS,
];

// shell: true so the globs expand exactly as they did in the npm script.
const result = spawnSync(`node ${args.join(" ")}`, { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
