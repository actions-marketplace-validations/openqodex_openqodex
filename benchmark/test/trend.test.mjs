// Intervals, the trend, its regression alarm and the accept step. Each
// failure is guarded on a controlled dataset whose effect is known, written
// as saved runs by the runner's own code (executeRun, with the review step
// that would call a model replaced by a report the test writes), scored by
// score.mjs and indexed the way publish-run.mjs indexes a run:
//
// 1. Two scorings of one run give different intervals: the bootstrap draws
//    from a clock, a random source or the folder's path, so a rescore moves
//    the interval and a published number cannot be reproduced.
// 2. Three repeats of one bug count as three independent trials: repeats
//    of one case share its code and its brief, so an interval that resamples
//    reviews instead of cases is narrower than the evidence allows.
// 3. A drop inside the noise fails the trend: a few whole cases flipping,
//    which happens between two runs of one build, is read as a regression.
// 4. A real drop passes it: a build that loses issues on every case, or
//    raises findings nobody has confirmed, is read as noise.
// 5. A critical issue found in every review before and in one now, or a
//    clean change that starts drawing findings, passes because the drop is
//    small next to the whole run.
// 6. A run that cannot be a baseline (legacy, draft, a dirty build, stopped,
//    missing scanners) is accepted, or the accepted entry is edited after it
//    was accepted and the trend compares against numbers nobody accepted,
//    or loses its accepted mark when publish-run.mjs writes it again.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assetUrl, buildEntry, entryProblems, groupKeys, listEntries } from "../lib/index.mjs";
import { mulberry32, seedOf } from "../lib/interval.mjs";
import { executeRun, planJobs, runManifest, sampleRecord } from "../lib/runner.mjs";
import { publishRun } from "../publish-run.mjs";
import { loadRun, scoreRun } from "../score.mjs";
import { compareConfig } from "../trend.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const SCORE = fileURLToPath(new URL("../score.mjs", import.meta.url));
const TREND = fileURLToPath(new URL("../trend.mjs", import.meta.url));
const CONFIG = "claude-graph-on";

const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const sha = (text) => createHash("sha256").update(text).digest("hex");

// A planted-style case with one bug per severity given, each on its own line
// of app.py and named by the word "flaw"; no severity makes a clean case.
const caseSpec = (name, severities) => ({
  id: name,
  guards: "g",
  language: "python",
  framework: "none",
  clean: severities.length === 0,
  bugs: severities.map((severity, i) => ({ id: `b${i + 1}`, file: "app.py", lines: [10 * (i + 1), 10 * (i + 1)], anchor: { line: 10 * (i + 1), text: "x" }, mentions: ["flaw"], kind: ["bug"], severity, found_by: ["reasoning"], truth: "t" })),
});
const finding = (file_path, line_number, title, severity = "major") => ({ origin: "agent", severity, category: "bug", confidence: 0.9, file_path, line_number, line_end: line_number, title, problem: "p", consequence: "c", fix: "f", candidate: null, source: null });

// A saved run of synthetic cases, written by executeRun into <parent>/<runId>.
// `found(c, b, r)` says whether review r of case index c finds bug index b;
// `unlisted(c, r)` is how many findings no spec lists that review shows.
async function savedRun({ parent, runId, cases, repeat, found, unlisted = () => 0, commit, startedAt, manifest: extra = {} }) {
  const out = join(parent, runId);
  const specsDir = join(parent, `${runId}-specs`);
  const names = cases.map((c) => c.name);
  const hashes = Object.fromEntries(names.map((n) => [n, sha(n)]));
  const caseIds = Object.fromEntries(names.map((n) => [n, `planted/${n}@${hashes[n].slice(0, 8)}`]));
  const specs = Object.fromEntries(cases.map((c) => [c.name, caseSpec(c.name, c.severities)]));
  for (const n of names) write(join(specsDir, `${n}.json`), JSON.stringify(specs[n]));
  const { jobs } = planJobs({ cases: names, caseIds, reviewers: ["claude"], graph: ["on"], repeat });
  const manifest = runManifest({
    startedAt,
    settings: {
      build: { commit, short: commit.slice(0, 7), dirty: false, cliVersion: "0.14.0", bundleHash: "b".repeat(64) },
      reviewers: { claude: { name: "claude", version: "2.1.300", model: "claude-opus-5-5" } },
      review: { web: "off" },
      cases: names,
      caseIds: names.map((n) => caseIds[n]),
      caseHashes: hashes,
      configs: [CONFIG],
      repeat,
      scannersComplete: true,
      draft: false,
      ...extra,
    },
    jobs,
  });
  await executeRun({
    out,
    manifest,
    jobs,
    copies: names.map((n) => [join(specsDir, `${n}.json`), `cases/${n}.json`]),
    runJob: async (job) => {
      const c = names.indexOf(job.case);
      const spec = specs[job.case];
      const shown = spec.bugs.filter((_, b) => found(c, b, job.repeat)).map((bug) => finding("app.py", bug.lines[0], "A flaw here", bug.severity));
      for (let i = 0; i < unlisted(c, job.repeat); i++) shown.push(finding("other.py", 100 + i, `Something else ${i}`));
      const report = { findings: shown, outside_change: [], dropped: [], completion: { status: "complete", missing: [], reviewer: { usage: { cost_usd: 0.1 } } } };
      const dir = join(out, "samples", job.case, job.config, String(job.repeat));
      write(join(dir, "sample.json"), JSON.stringify(sampleRecord({ job, attempt: 1, result: { code: 0, signal: null, wallMs: 20_000 }, report, who: null, startedAt: "t", failure: null, stopped: null })));
      write(join(dir, "report", "report.json"), JSON.stringify(report));
    },
  });
  return out;
}

// The index entry publish-run.mjs would write for a scored run folder.
function entryOf(folder, runId) {
  const run = loadRun(folder);
  const { score } = scoreRun(run);
  return buildEntry({ runId, manifest: run.manifest, resumes: [], score, asset: { url: assetUrl(runId), sha256: "e".repeat(64), bytes: 1000, files: 12, listHash: "f".repeat(64) }, privateListHash: "9".repeat(64) });
}

const putEntry = (index, entry) => write(join(index, "runs", `${entry.runId}.json`), `${JSON.stringify(entry, null, 2)}\n`);
const readEntryAt = (index, runId) => JSON.parse(readFileSync(join(index, "runs", `${runId}.json`), "utf8"));
const node = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const trend = (args) => node(TREND, args);

// Twenty cases of five major bugs each, the shape the trend tests share.
const TWENTY = Array.from({ length: 20 }, (_, i) => ({ name: `case-${String(i).padStart(2, "0")}`, severities: ["major", "major", "major", "major", "major"] }));
const ACCEPTED = { runId: "2026-10-11-aaaaaaa-base", commit: "a".repeat(40), startedAt: "2026-10-11T09:00:00.000Z" };
const NEWER = { runId: "2026-10-11-bbbbbbb-next", commit: "b".repeat(40), startedAt: "2026-10-11T10:00:00.000Z" };

// An index holding an accepted run and a newer run of the same cases, the
// newer one written but not accepted.
async function indexWith({ cases = TWENTY, before, after, unlistedBefore, unlistedAfter, repeat = 3 }) {
  const root = tempDir("oq-bench-trend-");
  const index = join(root, "index");
  const a = await savedRun({ parent: root, ...ACCEPTED, cases, repeat, found: before, unlisted: unlistedBefore });
  const b = await savedRun({ parent: root, ...NEWER, cases, repeat, found: after, unlisted: unlistedAfter });
  putEntry(index, entryOf(a, ACCEPTED.runId));
  putEntry(index, entryOf(b, NEWER.runId));
  const accepted = trend(["--accept", ACCEPTED.runId, "--by", "Sid", "--index", index]);
  expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
  return index;
}

describe("two scorings of one run give different intervals", () => {
  it("writes byte-identical intervals when one run is scored twice, and again from a copy in another folder", async () => {
    const root = tempDir("oq-bench-ci-");
    const cases = Array.from({ length: 12 }, (_, i) => ({ name: `ci-${i}`, severities: ["critical", "major", "minor"] }));
    const runId = "2026-10-11-ccccccc-ci";
    const pattern = (c, b, r) => (c * 7 + b * 3 + r * 5) % 4 !== 0;
    const folder = await savedRun({ parent: root, runId, cases, repeat: 3, found: pattern, unlisted: (c, r) => (c + r) % 3, commit: "c".repeat(40), startedAt: "2026-10-11T08:00:00.000Z" });
    const copy = join(root, "elsewhere", runId);
    cpSync(folder, copy, { recursive: true });
    const scorings = [];
    for (const [from, out] of [[folder, join(root, "out-1")], [folder, join(root, "out-2")], [copy, join(root, "out-3")]]) {
      const done = node(SCORE, [from, "--out", out, "--json"]);
      expect(done.status, done.stderr).toBe(0);
      scorings.push(JSON.parse(readFileSync(join(out, "score.json"), "utf8")));
    }
    const intervalsOf = (s) => JSON.stringify({ intervals: s.intervals, ci: [s.byConfig[CONFIG].issueRecall.all.ci, s.byConfig[CONFIG].issueRecall.criticalMajor.ci, s.byConfig[CONFIG].precision.lower.ci, s.byConfig[CONFIG].precision.upper.ci] });
    const first = scorings[0].byConfig[CONFIG];
    for (const ci of [first.issueRecall.all.ci, first.issueRecall.criticalMajor.ci, first.precision.lower.ci, first.precision.upper.ci]) {
      expect(ci).toHaveLength(2);
      expect(ci[0]).toBeLessThanOrEqual(ci[1]);
    }
    // Recall varies from case to case here, so its interval has a width.
    expect(first.issueRecall.all.ci[0]).toBeLessThan(first.issueRecall.all.ci[1]);
    expect(scorings[0].intervals).toMatchObject({ cluster: "case", resamples: 10_000, level: 0.95, runId });
    expect(intervalsOf(scorings[1])).toBe(intervalsOf(scorings[0]));
    expect(intervalsOf(scorings[2])).toBe(intervalsOf(scorings[0]));
  });

  it("draws the same numbers from the same seed, and other numbers from another", () => {
    const draw = (seed) => {
      const rand = mulberry32(seed);
      return Array.from({ length: 5 }, () => rand());
    };
    expect(draw(seedOf("run", "config", "metric"))).toEqual(draw(seedOf("run", "config", "metric")));
    expect(draw(seedOf("run", "config", "metric"))).not.toEqual(draw(seedOf("run", "config", "other")));
  });
});

describe("three repeats of one bug count as three independent trials", () => {
  it("gives three reviews that agree on every case the interval of one review, never a narrower one", async () => {
    const root = tempDir("oq-bench-repeats-");
    const cases = Array.from({ length: 12 }, (_, i) => ({ name: `rep-${i}`, severities: ["major", "major"] }));
    const runId = "2026-10-11-ddddddd-repeats";
    // Each case's result is fixed: the repeats add reviews, not evidence.
    const byCase = (c, b) => (c % 3 === 0 ? false : c % 3 === 1 ? b === 0 : true);
    const scoreOf = async (repeat) => {
      const folder = await savedRun({ parent: join(root, `r${repeat}`), runId, cases, repeat, found: (c, b) => byCase(c, b), commit: "d".repeat(40), startedAt: "2026-10-11T08:00:00.000Z" });
      return scoreRun(loadRun(folder)).score.byConfig[CONFIG];
    };
    const one = await scoreOf(1);
    const three = await scoreOf(3);
    expect(three.issueRecall.all.of).toBe(3 * one.issueRecall.all.of);
    expect(one.issueRecall.all.ci[1] - one.issueRecall.all.ci[0]).toBeGreaterThan(0.2);
    expect(three.issueRecall.all.ci).toEqual(one.issueRecall.all.ci);
    expect(three.precision.lower.ci).toEqual(one.precision.lower.ci);
  });
});

describe("a drop inside the noise fails the trend", () => {
  it("passes a newer run where three of twenty whole cases stop being found and one starts, a ten point drop", async () => {
    const lost = new Set([0, 1, 2]);
    const index = await indexWith({
      before: (c) => c < 15,
      after: (c) => (c < 15 && !lost.has(c)) || c === 15,
    });
    const shown = trend(["--index", index]);
    expect(shown.stdout).toMatch(/issue recall: 65\.0% against 75\.0%/);
    expect(shown.stdout).toMatch(/inside the noise/);
    expect(shown.status, shown.stdout + shown.stderr).toBe(0);
  });

  it("raises the alarm on at most one null pair in ten, over two hundred pairs drawn from one build's noise", () => {
    // Each case has its own chance of being found and of drawing findings no
    // spec lists; both runs of a pair draw from the same chances.
    const view = (runId, rand, chance, noise) => {
      const perCase = {};
      const perBug = {};
      for (let c = 0; c < 20; c++) {
        const id = `planted/n${c}@${sha(`n${c}`).slice(0, 8)}`;
        let hit = 0;
        let unl = 0;
        const bugs = {};
        for (let b = 0; b < 5; b++) {
          const found = [1, 2, 3].map(() => rand() < chance[c]);
          hit += found.filter(Boolean).length;
          bugs[`b${b}`] = { found, severity: "major", cause: null };
        }
        for (let r = 0; r < 3; r++) unl += Math.floor(rand() * (noise[c] + 1));
        perCase[id] = { issueRecall: { hit, of: 15 }, criticalMajor: { hit, of: 15 }, precision: { lower: { hit, of: hit + unl }, upper: { hit: hit + unl, of: hit + unl } }, controls: { hit: 0, of: 0 }, findings: hit + unl };
        perBug[id] = bugs;
      }
      return { runId, perCase: { [CONFIG]: perCase }, perBug: { [CONFIG]: perBug }, intervals: { cluster: "case", groups: null } };
    };
    const setup = mulberry32(seedOf("null pairs"));
    const chance = Array.from({ length: 20 }, () => setup());
    const noise = Array.from({ length: 20 }, () => Math.floor(setup() * 4));
    let alarms = 0;
    for (let pair = 0; pair < 200; pair++) {
      const rand = mulberry32(seedOf("null pair", String(pair)));
      const result = compareConfig(view(`2026-10-11-a${pair}`, rand, chance, noise), view(`2026-10-11-b${pair}`, rand, chance, noise), CONFIG, { resamples: 1000 });
      if (result.regressed) alarms++;
    }
    expect(alarms).toBeLessThanOrEqual(20);
  });
});

describe("a real drop passes the trend", () => {
  it("fails a newer run that finds two issues of five on every case where the accepted run found four, and shows three findings nobody confirmed per review", async () => {
    const index = await indexWith({
      before: (c, b) => b < 4,
      after: (c, b) => b < 2,
      unlistedAfter: () => 3,
    });
    const shown = trend(["--index", index]);
    expect(shown.status, shown.stdout + shown.stderr).toBe(1);
    expect(shown.stdout).toMatch(/issue recall: 40\.0% against 80\.0%/);
    expect(shown.stdout).toMatch(/precision, lower bound: .* outside the noise/);
    expect(shown.stdout).toMatch(/Regression/);
  });

  it("fails a newer run that misses a critical issue in two of three reviews, found in every review before, though the drop is inside the noise", async () => {
    const cases = [...TWENTY.slice(0, 19), { name: "case-crit", severities: ["critical", "major"] }, { name: "case-clean", severities: [] }];
    const crit = cases.findIndex((c) => c.name === "case-crit");
    const clean = cases.findIndex((c) => c.name === "case-clean");
    const index = await indexWith({
      cases,
      before: () => true,
      after: (c, b, r) => !(c === crit && b === 0 && r !== 1),
      unlistedAfter: (c, r) => (c === clean && r !== 3 ? 1 : 0),
    });
    const shown = trend(["--index", index]);
    expect(shown.status, shown.stdout + shown.stderr).toBe(1);
    expect(shown.stdout).toMatch(/issue recall: .* inside the noise/);
    expect(shown.stdout).toMatch(/case-crit.*b1.*critical.*3 of 3.*1 of 3/);
    expect(shown.stdout).toMatch(/case-clean.*2 of 3/);
  });
});

describe("a run that cannot be a baseline is accepted, or the accepted entry changes after it was accepted", () => {
  it("writes the accepted pointer with the run id, its commit and the score hash, for every group the run holds, and marks the entry", async () => {
    const index = await indexWith({ before: (c) => c < 15, after: (c) => c < 15 });
    const pointer = JSON.parse(readFileSync(join(index, "accepted.json"), "utf8"));
    const entry = readEntryAt(index, ACCEPTED.runId);
    const [group] = groupKeys(entry);
    expect(group.key).toBe(`planted|dev|none|review|laptop|claude|claude-opus-5-5|${CONFIG}|3`);
    // propose.mjs reads the loop's base from the top-level commit.
    expect(pointer).toMatchObject({ version: 1, commit: ACCEPTED.commit, runId: ACCEPTED.runId, acceptedBy: "Sid" });
    expect(pointer.scoreHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pointer.groups[group.key]).toMatchObject({ runId: ACCEPTED.runId, commit: ACCEPTED.commit, scoreHash: pointer.scoreHash, acceptedBy: "Sid" });
    expect(entry).toMatchObject({ accepted: true, acceptedBy: "Sid" });
    expect(entryProblems(entry)).toEqual([]);
    // Accepting the newer run moves the pointer and keeps the older entry's mark.
    const next = trend(["--accept", NEWER.runId, "--by", "Sid", "--index", index]);
    expect(next.status, next.stdout + next.stderr).toBe(0);
    const moved = JSON.parse(readFileSync(join(index, "accepted.json"), "utf8"));
    expect(moved).toMatchObject({ commit: NEWER.commit, runId: NEWER.runId });
    expect(moved.groups[group.key].runId).toBe(NEWER.runId);
    expect(readEntryAt(index, ACCEPTED.runId).accepted).toBe(true);
  });

  it("refuses a legacy run, a draft, a dirty build, a stopped run, a run with scanners missing, and a run already accepted", async () => {
    const index = await indexWith({ before: (c) => c < 15, after: (c) => c < 15 });
    const base = readEntryAt(index, NEWER.runId);
    const legacyId = readdirSync(fileURLToPath(new URL("../index/runs/", import.meta.url))).find((f) => f.endsWith(".json")).replace(/\.json$/, "");
    cpSync(fileURLToPath(new URL(`../index/runs/${legacyId}.json`, import.meta.url)), join(index, "runs", `${legacyId}.json`));
    const variants = [
      ["2026-10-11-bbbbbbb-draft", { draft: true }, /draft/],
      ["2026-10-11-bbbbbbb-dirty", { build: { ...base.build, dirty: true } }, /dirty/],
      ["2026-10-11-bbbbbbb-stopped", { ended: { how: "stopped", why: "budget" } }, /stopped|finished/],
      ["2026-10-11-bbbbbbb-scanners", { scannersComplete: false }, /scanner/],
    ];
    for (const [runId, change] of variants) {
      const entry = { ...base, ...change, runId, asset: { ...base.asset, url: assetUrl(runId) } };
      expect(entryProblems(entry)).toEqual([]);
      putEntry(index, entry);
    }
    for (const [runId, , why] of [[legacyId, null, /legacy/], ...variants]) {
      const refused = trend(["--accept", runId, "--by", "Sid", "--index", index]);
      expect(refused.status, `${runId}: ${refused.stdout}${refused.stderr}`).toBe(2);
      expect(refused.stderr).toMatch(why);
      expect(readEntryAt(index, runId).accepted).toBe(false);
    }
    const again = trend(["--accept", ACCEPTED.runId, "--by", "Sid", "--index", index]);
    expect(again.status).toBe(2);
    expect(again.stderr).toMatch(/already accepted/);
    expect(JSON.parse(readFileSync(join(index, "accepted.json"), "utf8")).runId).toBe(ACCEPTED.runId);
  });

  it("keeps the accepted mark when publish-run.mjs writes an accepted run's entry again", async () => {
    const root = tempDir("oq-bench-republish-");
    const runs = join(root, "index", "runs");
    const folder = await savedRun({ parent: root, ...ACCEPTED, cases: TWENTY.slice(0, 8), repeat: 1, found: (c) => c < 6 });
    const publish = () => publishRun(folder, { dryRun: true, writeIndex: true, runs, out: tempDir("oq-bench-republish-out-") });
    publish();
    const accepted = trend(["--accept", ACCEPTED.runId, "--by", "Sid", "--index", join(root, "index")]);
    expect(accepted.status, accepted.stdout + accepted.stderr).toBe(0);
    publish();
    expect(readEntryAt(join(root, "index"), ACCEPTED.runId)).toMatchObject({ accepted: true, acceptedBy: "Sid" });
    const shown = trend(["--index", join(root, "index")]);
    expect(shown.status, shown.stdout + shown.stderr).toBe(0);
  });

  it("refuses to compare against an accepted entry whose numbers changed after it was accepted", async () => {
    const index = await indexWith({ before: (c) => c < 15, after: (c) => c < 15 });
    const entry = readEntryAt(index, ACCEPTED.runId);
    const first = Object.keys(entry.perCase[CONFIG])[0];
    entry.perCase[CONFIG][first].issueRecall = { hit: 0, of: entry.perCase[CONFIG][first].issueRecall.of };
    putEntry(index, entry);
    const shown = trend(["--index", index]);
    expect(shown.status).toBe(2);
    expect(shown.stderr).toMatch(/changed since it was accepted/);
  });
});

describe("the trend over the committed index", () => {
  it("lists every committed run, the eleven legacy runs among them, with no interval for a legacy run and no alarm", () => {
    const shown = trend([]);
    expect(shown.status, shown.stdout + shown.stderr).toBe(0);
    const legacy = listEntries().filter(({ entry }) => entry.legacy);
    expect(legacy).toHaveLength(11);
    for (const { entry } of legacy) expect(shown.stdout).toContain(entry.runId);
    expect(shown.stdout).toMatch(/legacy: its own scorer, no interval/);
    expect(existsSync(join(fileURLToPath(new URL("../index/", import.meta.url)), "accepted.json")) || /No run is accepted yet/.test(shown.stdout)).toBe(true);
  });
});
