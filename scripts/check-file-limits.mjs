#!/usr/bin/env node
/**
 * The team's size limits, enforced: a source file is at most 200 lines, a test file at most
 * 400, and a source folder holds at most 8 files. Files already over a limit are recorded in
 * `file-limits-baseline.json` with their current size: they may not grow, and no new file may
 * join them. After a file shrinks, `node scripts/check-file-limits.mjs --write` lowers its entry.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "file-limits-baseline.json");
const MAX_LINES = { src: 200, test: 400 };
const MAX_FILES_PER_FOLDER = 8;

const tsFilesIn = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesIn(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

/** Same count as `wc -l`. */
const lineCount = (path) => (readFileSync(path, "utf8").match(/\n/g) ?? []).length;

const measure = (tree) =>
  tsFilesIn(join(ROOT, tree)).map((path) => ({
    file: relative(ROOT, path),
    lines: lineCount(path),
    limit: MAX_LINES[tree],
  }));

const overLimit = [...measure("src"), ...measure("test")].filter(
  ({ lines, limit }) => lines > limit,
);

if (process.argv.includes("--write")) {
  const baseline = Object.fromEntries(overLimit.map(({ file, lines }) => [file, lines]));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Wrote ${overLimit.length} entries to ${relative(ROOT, BASELINE_PATH)}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const failures = [];

for (const { file, lines, limit } of overLimit) {
  const allowed = baseline[file];
  if (allowed === undefined) failures.push(`${file}: ${lines} lines, over the ${limit}-line limit`);
  else if (lines > allowed) failures.push(`${file}: grew from ${allowed} to ${lines} lines`);
}

const folders = new Map();
for (const path of tsFilesIn(join(ROOT, "src"))) {
  const folder = relative(ROOT, dirname(path));
  folders.set(folder, (folders.get(folder) ?? 0) + 1);
}
for (const [folder, count] of folders) {
  if (count > MAX_FILES_PER_FOLDER) {
    failures.push(`${folder}: ${count} files, over the ${MAX_FILES_PER_FOLDER}-file folder limit`);
  }
}

const overNames = new Set(overLimit.map(({ file }) => file));
const stale = Object.keys(baseline).filter((file) => !overNames.has(file));
if (stale.length > 0) {
  console.log(`Baseline entries now within the limit (run with --write): ${stale.join(", ")}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`File limits hold: ${overLimit.length} known large files, none grew.`);
