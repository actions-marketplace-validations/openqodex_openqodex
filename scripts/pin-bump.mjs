// Pin freshness for the scanner table (packages/scanners/toolchain.json).
//
//   node scripts/pin-bump.mjs --report        the pin table: each scanner's
//                                             pin, its newest release at
//                                             least 7 days old, and whether
//                                             a bump is due
//   node scripts/pin-bump.mjs --matrix        the scanners with a bump due,
//                                             as a JSON list
//   node scripts/pin-bump.mjs --apply <tool>  moves that scanner's pin to
//                                             its newest release at least 7
//                                             days old and writes a changeset
//
// A GitHub release pin takes each asset's sha256 from the release (the
// asset's digest), and scripts/refresh-toolchain.mjs --verify then downloads
// every asset and checks it. A PyPI or RubyGems pin is re-locked with
// scripts/lock-scanners.mjs, and a gem's lowest Ruby is read from the gem's
// own metadata. A release younger than 7 days is never taken: a release
// that turns out to be malicious is usually pulled within days. The monthly
// workflow (.github/workflows/pin-bump.yml) opens one pull request per bump
// and never merges it. GITHUB_TOKEN, when set, is sent to the GitHub API
// only.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tablePath = join(root, "packages", "scanners", "toolchain.json");
const table = JSON.parse(readFileSync(tablePath, "utf8"));
const MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const now = Date.now();
const oldEnough = (date) => now - Date.parse(date) >= MIN_AGE_MS;

const isRelease = (v) => /^\d+(\.\d+)*$/.test(v);
function compare(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
const newest = (list) => list.sort((a, b) => compare(b.version, a.version))[0] ?? null;

// One retry for a connection that drops mid-answer; an HTTP error is final.
async function json(url, github = false, retry = true) {
  const headers = github && process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  try {
    const response = await fetch(url, { headers });
    if (!response.ok) throw Object.assign(new Error(`${url}: HTTP ${response.status}`), { final: true });
    return await response.json();
  } catch (error) {
    if (!retry || error.final) throw error;
    return json(url, github, false);
  }
}

// The newest release at least 7 days old: { version, date, extra }.
async function latest(tool, recipe) {
  if (recipe.method === "github-release") {
    // The tag's shape around the version: "v1.2.3", "1.2.3", "oxlint_v1.2.3".
    const prefix = recipe.tag.slice(0, recipe.tag.length - recipe.version.length);
    const releases = await json(`https://api.github.com/repos/${recipe.repo}/releases?per_page=100`, true);
    const fit = releases
      .filter((r) => !r.draft && !r.prerelease && r.tag_name.startsWith(prefix) && isRelease(r.tag_name.slice(prefix.length)) && oldEnough(r.published_at))
      .map((r) => ({ version: r.tag_name.slice(prefix.length), date: r.published_at, extra: r }));
    return newest(fit);
  }
  if (recipe.method === "uv") {
    const info = await json(`https://pypi.org/pypi/${recipe.package}/json`);
    const fit = Object.entries(info.releases)
      .filter(([v, files]) => isRelease(v) && files.length > 0 && !files.every((f) => f.yanked))
      .map(([v, files]) => ({ version: v, date: files.map((f) => f.upload_time_iso_8601).sort()[0] }))
      .filter((r) => oldEnough(r.date));
    return newest(fit);
  }
  // gem: every gem of the recipe moves to its own newest release.
  const moved = [];
  for (const spec of recipe.gems) {
    const [gem] = spec.split(":");
    const all = await json(`https://rubygems.org/api/v1/versions/${encodeURIComponent(gem)}.json`);
    const fit = all
      .filter((r) => r.platform === "ruby" && !r.prerelease && isRelease(r.number) && oldEnough(r.created_at))
      .map((r) => ({ version: r.number, date: r.created_at, ruby: r.ruby_version ?? ">= 0" }));
    const best = newest(fit);
    if (!best) throw new Error(`${tool}: ${gem} has no release at least 7 days old`);
    moved.push({ gem, ...best });
  }
  return { version: moved[0].version, date: moved[0].date, extra: moved };
}

async function report() {
  const rows = [];
  for (const [tool, recipe] of Object.entries(table.tools)) {
    const l = await latest(tool, recipe);
    const due = l !== null && compare(l.version, recipe.version) > 0;
    rows.push({ tool, pinned: recipe.version, latest: l?.version ?? "-", released: l?.date?.slice(0, 10) ?? "-", due });
  }
  return rows;
}

// The lowest Ruby a gem's "ruby_version" requirement allows: ">= 3.0.0" is 3.0.
function lowestRuby(requirement) {
  for (const part of requirement.split(",")) {
    const t = part.trim();
    if (!t.startsWith(">=")) continue;
    let v = t.slice(2).trim();
    while (v.endsWith(".0")) v = v.slice(0, -2);
    return v;
  }
  return null;
}

async function apply(tool) {
  const recipe = table.tools[tool];
  if (!recipe) throw new Error(`${tool} is not in the toolchain table`);
  const l = await latest(tool, recipe);
  if (l === null || compare(l.version, recipe.version) <= 0) {
    process.stdout.write(`${tool}: ${recipe.version} is the newest release at least 7 days old\n`);
    return null;
  }
  const from = recipe.version;
  if (recipe.method === "github-release") {
    const assets = new Map(l.extra.assets.map((a) => [a.name, a]));
    for (const [platform, asset] of Object.entries(recipe.assets)) {
      if (!asset) continue;
      const name = asset.name.split(from).join(l.version);
      const found = assets.get(name);
      if (!found) throw new Error(`${tool} ${l.version}: no asset named ${name} for ${platform}; the names changed, pin it by hand`);
      if (!/^sha256:[0-9a-f]{64}$/.test(found.digest ?? "")) throw new Error(`${tool} ${l.version}: ${name} has no sha256 digest; pin it by hand`);
      recipe.assets[platform] = {
        ...asset,
        name,
        url: found.browser_download_url,
        sha256: found.digest.slice("sha256:".length),
        binaryPath: asset.binaryPath.split(from).join(l.version),
      };
    }
    recipe.tag = l.extra.tag_name;
  } else if (recipe.method === "gem") {
    recipe.gems = l.extra.map((g) => `${g.gem}:${g.version}`);
    const lowest = l.extra.map((g) => lowestRuby(g.ruby)).filter((v) => v !== null).sort(compare).pop();
    if (lowest) recipe.needs = `ruby>=${lowest}`;
  }
  recipe.version = l.version;
  writeFileSync(tablePath, `${JSON.stringify(table, null, 2)}\n`);
  if (recipe.method !== "github-release") execFileSync(process.execPath, [join(root, "scripts", "lock-scanners.mjs"), tool], { stdio: "inherit" });
  writeFileSync(
    join(root, ".changeset", `pin-${tool}-${l.version.replace(/\./g, "-")}.md`),
    `---\n"openqodex": patch\n---\n\nThe built-in ${tool} scanner moves from ${from} to ${l.version}, released ${l.date.slice(0, 10)}.\n`,
  );
  process.stdout.write(`${tool}: ${from} -> ${l.version}\n`);
  return l.version;
}

const [mode, arg] = process.argv.slice(2);
if (mode === "--report" && arg === undefined) {
  const rows = await report();
  process.stdout.write("| Scanner | Pinned | Newest 7 days old | Released | Bump due |\n|---|---|---|---|---|\n");
  for (const r of rows) process.stdout.write(`| ${r.tool} | ${r.pinned} | ${r.latest} | ${r.released} | ${r.due ? "yes" : "no"} |\n`);
} else if (mode === "--matrix" && arg === undefined) {
  process.stdout.write(`${JSON.stringify((await report()).filter((r) => r.due).map((r) => r.tool))}\n`);
} else if (mode === "--apply" && arg !== undefined) {
  await apply(arg);
} else {
  process.stderr.write("usage: node scripts/pin-bump.mjs --report | --matrix | --apply <tool>\n");
  process.exit(2);
}
