#!/usr/bin/env node
/**
 * CI acceptance: the README "## The 30-second example" TypeScript fence
 * must stay under 15 non-empty, non-comment lines and reference createMcpApp.
 * That the fence actually runs is covered by test/mcp/readme-quickstart.test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 15;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

const sectionMatch = readme.match(/## The 30-second example\n([\s\S]*?)(?=\n## |\n$)/);
if (!sectionMatch) {
  console.error("check-quickstart: missing '## The 30-second example' in README.md");
  process.exit(1);
}

const fenceMatch = sectionMatch[1].match(/```ts\n([\s\S]*?)```/);
if (!fenceMatch) {
  console.error("check-quickstart: no ```ts fence under The 30-second example");
  process.exit(1);
}

const body = fenceMatch[1];
const lines = body
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("//"));

if (!body.includes("createMcpApp")) {
  console.error("check-quickstart: example must reference createMcpApp");
  process.exit(1);
}

if (lines.length > MAX_LINES) {
  console.error(
    `check-quickstart: example has ${lines.length} non-empty non-comment lines (max ${MAX_LINES})`,
  );
  process.exit(1);
}

console.log(`check-quickstart OK (${lines.length}/${MAX_LINES} lines)`);
