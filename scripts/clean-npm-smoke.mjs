#!/usr/bin/env node
/**
 * Prove the published shape: npm pack → clean install → import createMcpApp.
 * Does not replace a live vendor-client session (see docs/compatibility.md).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tarball = join(root, `${pkg.name}-${pkg.version}.tgz`);

execFileSync("npm", ["pack", "--silent"], { cwd: root, stdio: "inherit" });

const dir = mkdtempSync(join(tmpdir(), "mcp-trellis-smoke-"));
try {
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "pipe" });
  execFileSync("npm", ["install", tarball], { cwd: dir, stdio: "inherit" });
  const check = `
    import { createMcpApp } from "mcp-trellis";
    import { asNodeHandler } from "mcp-trellis/node";
    if (typeof createMcpApp !== "function") throw new Error("createMcpApp missing");
    if (typeof asNodeHandler !== "function") throw new Error("asNodeHandler missing");
    console.log("clean-npm-smoke OK", process.env.npm_package_name ?? "mcp-trellis");
  `;
  execFileSync("node", ["--input-type=module", "-e", check], {
    cwd: dir,
    stdio: "inherit",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
  try {
    rmSync(tarball, { force: true });
  } catch {
    // ignore
  }
}
