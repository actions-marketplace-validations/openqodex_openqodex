#!/usr/bin/env node
// Replays saved submissions with the product's checks, with no reviewer:
//   node benchmark/loop/replay.mjs threshold|union|floor <run> [--specs <folder>]
//                                 [<run> [--specs <folder>]]... [--out <file>]
// Threshold shows info at the product's confidence floor. Union merges
// repeats 1 and 2 per case and configuration. Floor sweeps 0.6 to 0.9.
// Counts use the planted matching diagnostic in lib/score.mjs, without
// adjudication. --specs follows its run; otherwise its own cases are used.
// Saved runs are read only. Exit 0 printed, 2 invalid input or output path.
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSubmission, DEFAULT_CONFIG, GLOBAL_CONFIDENCE_FLOOR, parseDiffCoverage, removedRuns, unquoteDiffPath } from "../../packages/core/dist/index.js";
import { mergeFindings } from "../../packages/review/dist/index.js";
import { fileList, resultsRoot } from "../lib/index.mjs";
import { groupBy, scoreSample, shownFindings, summarize } from "../lib/score.mjs";
import { loadRun } from "../score.mjs";

// The product owns validation, deduplication, severity visibility and lens
// floors. This wrapper changes only the two settings being replayed.
export function replaySubmission(args, { floor = GLOBAL_CONFIDENCE_FLOOR, threshold = args.config.severityThreshold } = {}) {
  return checkSubmission({ ...args, confidenceFloor: floor, config: { ...args.config, severityThreshold: threshold } });
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const inFolder = (folder, path) => {
  const rel = relative(folder, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

// A canonical path even when the output does not exist: resolve the nearest
// existing parent, so a symlink cannot put --out back inside a saved run.
function canonicalPath(path) {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error(`cannot resolve ${path}`);
  return join(canonicalPath(parent), basename(path));
}

function checkOutput(path, folders) {
  const target = canonicalPath(resolve(path));
  const saved = folders.map((f) => realpathSync(f));
  // Protect any saved run under the standard store, including one not being
  // replayed. An existing hard link to an input also aliases its contents.
  if (inFolder(canonicalPath(resultsRoot), target) || saved.some((f) => inFolder(f, target))) throw new Error("--out cannot write into a run folder");
  if (existsSync(target)) {
    const out = statSync(target);
    for (const folder of saved) for (const file of fileList(folder)) {
      const s = statSync(join(folder, file));
      if (s.dev === out.dev && s.ino === out.ino) throw new Error("--out cannot overwrite a file from a run folder");
    }
  }
  return target;
}

// Adapt the recorded diff to Change, never the current case's source tree.
// core's coverage parser includes context when given a contextual diff, so
// remove those context positions before passing it to checkSubmission.
// Line limits are conservative: the highest line actually present in a hunk
// or a successful recorded read. No full snapshot was saved in legacy runs.
function savedChange(brief, manifest, report, trace) {
  const blocks = [...brief.matchAll(/^```diff\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length === 0) throw new Error("the saved brief has no diff; the change cannot be replayed");
  const diff = blocks.map((m) => m[1]).join("\n");
  const coverage = parseDiffCoverage(diff);
  const limits = new Map();
  const observe = (path, line) => limits.set(path, Math.max(limits.get(path) ?? 0, line));
  let path = null;
  let next = null;
  let left = 0;
  let right = 0;
  for (const line of diff.split("\n")) {
    if (left > 0 || right > 0) {
      if (line.startsWith(" ")) {
        coverage.get(path)?.delete(next);
        observe(path, next++);
        left--; right--;
      } else if (line.startsWith("+")) {
        observe(path, next++);
        right--;
      } else if (line.startsWith("-")) left--;
      continue;
    }
    if (line.startsWith("diff --git ")) { path = null; next = null; }
    else if (line.startsWith("+++ ")) {
      const raw = unquoteDiffPath(line.slice(4).replace(/\t$/, ""));
      path = raw === "/dev/null" ? null : raw.replace(/^b\//, "");
    } else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) {
        next = Number(m[3]);
        left = m[2] === undefined ? 1 : Number(m[2]);
        right = m[4] === undefined ? 1 : Number(m[4]);
      }
    }
  }
  for (const t of trace ?? []) if (t.tool === "Read" && t.ok && t.inside === true && Array.isArray(t.range)) observe(t.path, t.range[1]);
  const deletionPoints = new Map();
  for (const block of diff.split(/(?=^diff --git )/m)) {
    const files = [...parseDiffCoverage(block).keys()];
    if (files.length !== 1) continue;
    const file = files[0];
    const count = limits.get(file) ?? 0;
    deletionPoints.set(file, removedRuns(block).map((r) => ({ after: r.after, lines: r.lines.length, anchors: [r.after, r.after + 1].filter((n) => n >= 1 && n <= count) })));
  }
  const files = [...coverage.keys()].map((p) => ({ path: p, status: "modified", oldPath: null, binary: false }));
  const change = { id: manifest.change_id, shortId: manifest.change_id.slice(0, 12), repoRoot: ".", baseRef: report.base?.ref ?? "saved", baseSha: report.base?.sha ?? "saved", files, changedPaths: files.map((f) => f.path), coverage, deletionPoints, diff, notReviewed: report.not_reviewed_paths ?? [], stats: report.stats };
  return { change, lineCount: (p) => limits.get(p) ?? null };
}

function inputsOf(folder, a) {
  const dir = join(folder, "samples", a.case, a.config, String(a.repeat), "report");
  for (const [name, value] of [["report.json", a.report], ["submission.json", a.submission], ["scan.json", a.scan], ["brief.md", a.brief]]) if (value === null) throw new Error(`${dir}: missing ${name}; cannot replay the product's checks`);
  if (a.report.completion?.status !== "complete") throw new Error(`${dir}: the saved review is not complete`);
  const manifest = readJson(join(dir, "manifest.json"));
  const scan = { ...a.scan, secretFingerprints: a.scan.secretFingerprints ?? [] };
  const settings = { ...DEFAULT_CONFIG, blockOnSeverity: a.report.block_on_severity ?? null };
  return { ...savedChange(a.brief, manifest, a.report, a.trace), manifest, scan, config: settings, submission: a.submission };
}

const counts = (scores) => {
  const s = summarize(scores);
  return { hits: s.recall.hit, of: s.recall.of, false: s.falseFindings, nonHits: s.precision.of - s.precision.hit, testRequests: s.testGaps, findings: scores.reduce((n, s) => n + s.findings.length, 0) };
};

export function replayRun(folder, { mode = "threshold", specsDir = null, floors = [0.6, 0.7, 0.8, 0.9] } = {}) {
  if (!["threshold", "union", "floor"].includes(mode)) throw new Error(`unknown replay ${mode}`);
  if (!Array.isArray(floors) || floors.length === 0 || floors.some((f) => !Number.isFinite(f) || f < 0 || f > 1)) throw new Error("floors must be numbers from 0 to 1");
  const run = loadRun(folder, { specsDir });
  if (run.manifest.mode && run.manifest.mode !== "review") throw new Error("replays need reviewer submissions, not a scanner-only run");
  const firsts = run.attempts.filter((a) => a.attempt === 1);
  const checked = firsts.map((a) => ({ ...a, args: inputsOf(folder, a) }));
  const reportAt = (a, settings = {}) => {
    const check = replaySubmission(a.args, settings);
    if (!check.ok) throw new Error(`${a.case}/${a.config}/${a.repeat}: core rejected the saved submission:\n${check.errors.join("\n")}`);
    return { ...check.report, completion: a.report.completion };
  };
  const score = (a, report) => scoreSample({ spec: run.specs[a.case], brief: a.brief, row: a.row, report, testOnly: (run.manifest.suite ?? "planted") === "planted" });
  const rows = [];
  for (const config of run.manifest.configs ?? [...groupBy(checked, (a) => a.config).keys()]) {
    const samples = checked.filter((a) => a.config === config);
    if (mode === "union") {
      const pairs = [...groupBy(samples, (a) => a.case).values()].map((as) => [as.find((a) => a.repeat === 1), as.find((a) => a.repeat === 2)]);
      const expectedCases = run.manifest.cases ?? Object.keys(run.specs);
      if (pairs.length !== expectedCases.length || pairs.some(([a, b]) => !a || !b)) {
        rows.push({ config, status: "insufficient repeats" });
        continue;
      }
      const before = [];
      const after = [];
      for (const [a, b] of pairs) {
        const primary = reportAt(a);
        const second = reportAt(b);
        const merged = mergeFindings({ name: "repeat 1", findings: shownFindings(primary) }, { name: "repeat 2", findings: shownFindings(second) });
        before.push(score(a, primary));
        after.push(score(a, { ...primary, findings: merged.findings, outside_change: [] }));
      }
      const base = counts(before);
      const union = counts(after);
      rows.push({ config, status: "replayed", beforeHits: base.hits, beforeNonHits: base.nonHits, ...union });
    } else {
      const planned = (run.manifest.cases?.length ?? Object.keys(run.specs).length) * run.manifest.repeat;
      if (samples.length !== planned) throw new Error(`${config}: ${samples.length} first attempts saved, ${planned} planned; cannot replay every submission`);
      const base = counts(samples.map((a) => score(a, reportAt(a))));
      if (mode === "threshold") {
        const info = counts(samples.map((a) => score(a, reportAt(a, { threshold: "info" }))));
        rows.push({ config, samples: samples.length, beforeHits: base.hits, beforeTestRequests: base.testRequests, ...info, addedHits: info.hits - base.hits, addedTestRequests: info.testRequests - base.testRequests });
      } else for (const floor of floors) rows.push({ config, samples: samples.length, floor, ...counts(samples.map((a) => score(a, reportAt(a, { floor })))) });
    }
  }
  return { run: basename(folder), mode, specsFrom: run.specsFrom ?? "the run's own cases/", rows };
}

const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
function render(runs) {
  const out = ["# Saved-run replays", "", "No reviewer calls. Counts use the planted matching diagnostic, without adjudication. False means unlisted under that diagnostic; counted non-hits also include near misses and wrong kinds.", "", "Checks: built core checkSubmission and built review mergeFindings. Legacy citation limits use observed diff and read ranges, not a full snapshot. Lens floors still apply. Threshold and floor replays use every first attempt; union uses repeats 1 and 2 only.", ""];
  for (const r of runs) {
    out.push(`## ${r.run}: ${r.mode}`, "", `Specs: ${r.specsFrom}.`, "");
    if (r.mode === "threshold") out.push(table(["Configuration", "Samples", "Minor hits", "Info hits", "Added hits", "Minor tests", "Info tests", "Added tests", "False at info", "Counted non-hits at info"], r.rows.map((x) => [x.config, x.samples, `${x.beforeHits}/${x.of}`, `${x.hits}/${x.of}`, x.addedHits, x.beforeTestRequests, x.testRequests, x.addedTestRequests, x.false, x.nonHits])), "");
    else if (r.mode === "union") out.push(table(["Configuration", "Repeat 1 hits", "Union hits", "Repeat 1 non-hits", "Union non-hits", "Union findings", "Status"], r.rows.map((x) => [x.config, x.status === "replayed" ? `${x.beforeHits}/${x.of}` : "n/a", x.status === "replayed" ? `${x.hits}/${x.of}` : "n/a", x.beforeNonHits ?? "n/a", x.nonHits ?? "n/a", x.findings ?? "n/a", x.status])), "");
    else out.push(table(["Configuration", "Samples", "Floor", "Hits", "False", "Counted non-hits", "Test requests"], r.rows.map((x) => [x.config, x.samples, x.floor.toFixed(1), `${x.hits}/${x.of}`, x.false, x.nonHits, x.testRequests])), "");
  }
  return out.join("\n");
}

function main(argv) {
  const mode = argv[0];
  const requests = [];
  let out = null;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--specs") {
      if (!requests.length || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--specs takes a folder and follows its run");
      requests.at(-1).specs = argv[++i];
    } else if (a === "--out") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--out takes a file");
      out = argv[++i];
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else requests.push({ folder: existsSync(a) ? resolve(a) : join(resultsRoot, a), specs: null });
  }
  if (!requests.length || !["threshold", "union", "floor"].includes(mode)) throw new Error("usage: node benchmark/loop/replay.mjs threshold|union|floor <run> [--specs <folder>] [<run> ...] [--out <file>]");
  const target = out === null ? null : checkOutput(out, requests.map((r) => r.folder));
  const runs = requests.map((r) => replayRun(r.folder, { mode, specsDir: r.specs === null ? null : existsSync(r.specs) ? resolve(r.specs) : join(r.folder, r.specs) }));
  const text = render(runs);
  if (target !== null) writeFileSync(target, text);
  process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { process.stderr.write(`replay: ${e.message}\n`); process.exitCode = 2; }
}
