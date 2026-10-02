// Checks the pinned scanner table against the real downloads.
// `node scripts/refresh-toolchain.mjs --verify` downloads every GitHub release
// asset in packages/scanners/toolchain.json, hashes it, prints one line per
// asset and exits 1 on any mismatch, missing asset or failed download.
// A version bump: edit the table (version, tag, asset names, URLs, sha256 from
// the upstream checksum file), then run this to prove every hash.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] !== "--verify" || process.argv.length !== 3) {
  process.stderr.write("usage: node scripts/refresh-toolchain.mjs --verify\n");
  process.exit(2);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const table = JSON.parse(readFileSync(join(root, "packages", "scanners", "toolchain.json"), "utf8"));
const platforms = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

const jobs = [];
for (const [tool, recipe] of Object.entries(table.tools)) {
  if (recipe.method !== "github-release") continue;
  for (const platform of platforms) jobs.push({ tool, platform, asset: recipe.assets?.[platform] ?? null });
}

async function sha256Of(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const hash = createHash("sha256");
  for await (const chunk of response.body) hash.update(chunk);
  return hash.digest("hex");
}

async function check({ tool, platform, asset }) {
  const label = `${tool} ${platform}`;
  if (!asset) return `${label}: FAIL no asset`;
  if (!/^[0-9a-f]{64}$/.test(asset.sha256 ?? "")) return `${label}: FAIL no sha256`;
  try {
    const actual = await sha256Of(asset.url);
    return actual === asset.sha256 ? `${label}: OK ${actual}` : `${label}: FAIL expected ${asset.sha256}, got ${actual}`;
  } catch (error) {
    return `${label}: FAIL ${error instanceof Error ? error.message : String(error)}`;
  }
}

const results = Array.from({ length: jobs.length }, () => "");
let next = 0;
await Promise.all(
  Array.from({ length: 6 }, async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      results[index] = await check(jobs[index]);
    }
  }),
);
for (const line of results) process.stdout.write(`${line}\n`);
const failed = results.filter((line) => line.includes(": FAIL")).length;
process.stdout.write(`${jobs.length - failed} of ${jobs.length} assets verified\n`);
process.exitCode = failed > 0 ? 1 : 0;
