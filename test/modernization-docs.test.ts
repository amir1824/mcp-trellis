/**
 * SCRUM-25 slice T1: pins the SHAPE of the modernization documents and of the one measurement script.
 * It proves each document keeps its required sections, statuses and citations. It does not prove that
 * a claim in them is true: that is checked by review against the spec and the source. The `src/`
 * half of M1 (no file under src/ changes) is a diff check at review time, not a runtime check.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_PROTOCOL_VERSION, PROTOCOL_VERSIONS } from "../src/mcp/protocol.js";

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const matrix = read("docs/modernization/capability-matrix.md");
const comparison = read("docs/modernization/sdk-comparison.md");
const baselines = read("docs/modernization/baselines.md");
const adr = read("docs/adr/0001-protocol-modernization.md");
const script = read("scripts/measure-baseline.mjs");
const manifest = JSON.parse(read("package.json")) as { dependencies?: unknown };
const lockfile = JSON.parse(read("package-lock.json")) as {
  packages: Record<string, { dependencies?: unknown }>;
};
const allDocs = [matrix, comparison, baselines, adr].join("\n");

describe("modernization documents: review of the implementation and the matrix", () => {
  it("R1 the matrix names the revision and the version it reviews", () => {
    assert.match(matrix, /MCP 2026-07-28/);
    assert.match(matrix, /mcp-trellis 3\.4\.0/);
  });

  it("R2 table rows, not only the legend, carry the five statuses the ticket names", () => {
    assert.match(matrix, /^\| [A-Z]-\d+ \|.*\| supported[ |:]/m);
    assert.match(matrix, /^\| [A-Z]-\d+ \|.*\| partial[ |:]/m);
    assert.match(matrix, /^\| [A-Z]-\d+ \|.*\| missing[ |;:]/m);
    assert.match(matrix, /^\| [A-Z]-\d+ \|.*\| deprecated /m);
    assert.match(matrix, /^\| Skills over MCP .*`experimental`/m);
  });

  it("R3 mandatory changes sit in their own section apart from optional capabilities", () => {
    assert.match(matrix, /^## 1\. Mandatory protocol changes/m);
    assert.match(matrix, /^## 2\. Optional capabilities and deprecated features/m);
  });

  it("R10 the matrix has an Unverified section", () => {
    assert.match(matrix, /^## Unverified/m);
  });

  it("R10 M3 every matrix row cites a spec URL base or says unverified", () => {
    assert.doesNotMatch(matrix, /^\| [A-Z]-\d+ \|(?!.*(?:`S\/|`E`|https:\/\/|unverified)).*$/m);
  });

  it("R15 the matrix lists experimental extensions as optional", () => {
    assert.match(matrix, /^## 6\. Experimental extensions/m);
    assert.match(adr, /optional and off by default/);
  });

  it("R16 the matrix maps rows to tickets and releases", () => {
    assert.match(matrix, /^## 5\. Proposed implementation scope/m);
    assert.match(matrix, /T2 Protocol Modernization \| A/);
  });

  it("R19 items the ticket puts out of scope are flagged, with the mandatory check", () => {
    assert.match(matrix, /^### Out of scope per ticket/m);
    assert.match(matrix, /None of these is made mandatory by 2026-07-28/);
  });

  it("R20 the matrix assesses unauthorized discovery and access on the current source", () => {
    assert.match(matrix, /^### Unauthorized discovery and access, on the current source/m);
    assert.match(matrix, /hides `tools\/list` entries only/);
    assert.match(adr, /should T3 make a hidden tool answer like an unknown one/);
  });

  it("R21 the matrix assesses caller-dependent caches on the current source", () => {
    assert.match(matrix, /^### Caches that depend on the caller/m);
    assert.match(matrix, /cacheScope: "private"/);
  });

  it("R22 each row names the existing test that covers it, or none", () => {
    assert.match(matrix, /\| Code \| Test \|/);
  });
});

describe("modernization documents: SDK comparison and ADR", () => {
  it("R4 the comparison weighs keeping the code against adopting the SDK", () => {
    assert.match(comparison, /^## Comparison/m);
    assert.match(comparison, /Adopt the SDK/);
  });

  it("R17 the default is to keep the code and the SDK needs a demonstrated justification", () => {
    assert.match(comparison, /^## Decision rule \(default: keep the current code\)/m);
    assert.match(comparison, /demonstrated justification/);
  });

  it("R18 the comparison has public API and semantic-version impact rows", () => {
    assert.match(comparison, /^## Public API and semantic-version impact/m);
    assert.match(comparison, /minor \(3\.5\.0\)/);
  });

  it("R13 the comparison covers Node and the edge runtime, and says what was not run", () => {
    assert.match(comparison, /^## Runtime compatibility \(Node and edge\)/m);
    assert.match(comparison, /compile-checked only and was not run/);
    assert.match(baselines, /Latency on an edge runtime is not measured at all/);
  });

  it("R14 the comparison covers BYO authentication and the authorization boundary", () => {
    assert.match(comparison, /^## BYO authentication and authorization boundaries/m);
  });

  it("R6 the ADR recommends an approach and names the alternative rejected", () => {
    assert.match(adr, /^## Decision \(recommended\)/m);
    assert.match(adr, /^## Alternative rejected/m);
  });

  it("R11 M2 the ADR, the budgets and the analysis stay Proposed, never Accepted or Approved", () => {
    assert.match(adr, /^Status: \*\*Proposed\*\*/m);
    assert.match(matrix, /^Status: \*\*Proposed\.\*\*/m);
    assert.match(baselines, /^Status: \*\*Proposed\.\*\*/m);
    assert.doesNotMatch(allDocs, /^Status: \*\*(Accepted|Approved)/m);
  });

  it("R9 the ADR proposes no runtime dependency and leaves the decision to the maintainer", () => {
    assert.match(adr, /no runtime dependency is proposed/);
    assert.match(adr, /maintainer's decision/);
  });

  it("R8 R8b the ADR states that nothing in it is built and lists open points for the maintainer", () => {
    assert.match(adr, /nothing in it is built/);
    assert.match(adr, /^## Open points for the maintainer/m);
  });
});

describe("modernization documents: baselines, budgets and constraints", () => {
  it("R5 the baselines carry the measured package size, a latency table and the quickstart size", () => {
    assert.match(baselines, /"size":\d+,"unpackedSize":\d+/);
    assert.match(baselines, /"p95Ms":\d/);
    assert.match(baselines, /check-quickstart OK \(\d+\/\d+ lines\)/);
  });

  it("R7 the budgets are numeric, Proposed and tied to a check command", () => {
    assert.match(baselines, /^## Proposed regression budgets/m);
    assert.match(baselines, /at most \d[\d,]* bytes/);
    assert.match(baselines, /at most 0\.5 ms/);
  });

  it("R9 M1 package.json and the lockfile root declare no runtime dependencies", () => {
    assert.equal(manifest.dependencies, undefined);
    assert.equal(lockfile.packages[""]?.dependencies, undefined);
  });

  it("R12 T1 left the supported protocol versions and the default as they were", () => {
    assert.deepEqual([...PROTOCOL_VERSIONS], ["2024-11-05", "2025-03-26", "2025-06-18"]);
    assert.equal(DEFAULT_PROTOCOL_VERSION, "2025-06-18");
  });

  it("M4 the public docs carry no exploit steps or proof of concept", () => {
    assert.doesNotMatch(allDocs, /exploit|proof[- ]of[- ]concept|\bPoC\b/i);
  });

  it("M5 the measurement script writes no file and reads no environment variable", () => {
    assert.doesNotMatch(script, /writeFile|appendFile|createWriteStream|mkdir|unlink|rmSync/);
    assert.doesNotMatch(script, /process\.env/);
    assert.match(script, /notMeasured/);
  });
});
