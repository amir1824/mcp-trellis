// Run with Node 20+: node scripts/weekly-metrics.mjs [output-directory]
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repository = "amir1824/mcp-trellis";
const output = resolve(process.argv[2] ?? "metrics");
const collectedAt = new Date().toISOString();
const errors = [];
const gh = (endpoint) => {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", endpoint], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    errors.push(
      `GitHub endpoint unavailable: ${endpoint}. Check gh auth and repository permissions.`,
    );
    return null;
  }
};
const repositoryData = gh(`repos/${repository}`);
const views = gh(`repos/${repository}/traffic/views?per=day`);
const clones = gh(`repos/${repository}/traffic/clones?per=day`);
// Search counts actual issues, excluding pull requests. Not all issues are user questions.
const issues = gh(`search/issues?q=${encodeURIComponent(`repo:${repository} is:issue`)}`);
let npm = null;
try {
  const response = await fetch("https://api.npmjs.org/downloads/point/last-week/mcp-trellis", {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  npm = await response.json();
} catch {
  errors.push("npm weekly downloads unavailable");
}
const snapshot = {
  collectedAt,
  repository,
  github: {
    stars: repositoryData?.stargazers_count ?? null,
    issuesTotal: issues?.total_count ?? null,
    views,
    clones,
  },
  npm,
  manual: {
    tried: null,
    integrated: null,
    independentSuccessfulIntegrations: null,
    repeatUsers: null,
    oauthTimeSavedQuotes: null,
    note: "Fill only from observed feedback; null means unknown, not zero.",
  },
  notes: [
    "Traffic API windows overlap: deduplicate daily counts by UTC date; never sum rolling totals.",
    "Daily unique visitors cannot be summed into monthly unique people. Report as visitor-days or separate windows.",
    "npm downloads include automation and repeat downloads; they are not unique installs or activations.",
  ],
  errors,
};
await mkdir(output, { recursive: true });
const path = resolve(output, `${collectedAt.replace(/[:.]/g, "-")}.json`);
await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx" });
console.log(`Saved ${path}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
