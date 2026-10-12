#!/usr/bin/env node
// What each scanner contributed to a saved run, and the first clause of the
// scanner keep rule against a baseline, from the runs' files only:
//
//   node benchmark/scanners.mjs <run> [--specs <folder>]
//                               [--against <baseline> [--specs <folder>]]
//                               [--input-change pin-bump:<scanner>|semgrep-packs]
//                               [--decisions <file>] [--change <SC-id>] [--ledger <file>]
//                               [--release <version>] [--out <folder>] [--json]
//
// <run> is a run folder, or a run id under benchmark/results (fetch a
// published one with fetch-run.mjs); a review run and a scanner-only run
// both work, and so does a run saved before the scan recorded its
// selection, trail and stages (backfill: the tables print what the files
// hold and name what they lack first). --specs reads the run named before
// it against other specs, such as an amended copy; a folder name that is not
// a path is looked up inside that run (cases-v2).
//
// Prints, in this order: what the scans did not record, then the scanner
// tables (what each raised and what became of it; the truth it found), the
// rule table (by kept candidates, with the rules that meet the default-off
// bar), the drop classes (lib/drops.mjs), the gaps by language and class,
// the time table, and leave one out. The definitions are in
// lib/scanners.mjs. Writes scanners.json into the run folder, or into
// --out; a legacy run's folder is the published original, so its
// scanners.json is written only with --out.
//
// --against <baseline> judges the run as a change against the baseline: it
// refuses (exit 2) when either run is from the test split, the runs differ
// in suite, mode or split, their Semgrep rule packs or scanner toolchain
// differ beyond the one input --input-change names (or are not recorded; a
// pin bump is checked entry by entry against the toolchain table and lock
// files of each run's build commit, read with git), a
// scanner did not run where truth lies or may lie in its remit, or a
// planned scan is missing; else it applies K1: no truth item the baseline
// found with issue-level evidence is lost. Then it hands both runs to the
// acceptance rule (lib/scanners.mjs ACCEPTANCE_RULE, loop/decide.mjs
// decideScanner) for K2 to K4: K2 by deterministic dominance (plan
// amendment A1), read with the rulings of the adjudication file
// (--decisions, benchmark/review-queue/decisions.jsonl by default), and the
// losses and review run (K4) of the change's record when --change names its
// line in the scanner ledger (--ledger, benchmark/index/ledger/scanner.jsonl
// by default). It writes no ledger line.
//
// A test-split run prints only with --release naming its own release.
//
// Exit codes: 0 printed (and with --against, nothing reverts the change:
// kept, pending rulings, pending K4, or undecided); 1 the change is
// reverted (K1 fails, a removed candidate is ruled true, K3 or K4 fails); 2
// refused, or a run cannot be read.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, buildCase, caseHash, casesRoot, diffOf, parseCaseId, readCase, repoRoot } from "./lib/cases.mjs";
import { DROP_CLASSES, POINTS_AT } from "./lib/drops.mjs";
import { resultsRoot } from "./lib/index.mjs";
import { ACCEPTANCE_RULE, GAP, INPUT_CHANGES, RULE_OFF, SCANNERS_VERSION, analyseRun, judgeAgainst, runRefusals, scannerReport, toolchainRecord } from "./lib/scanners.mjs";
import { readRulings, scanSide } from "./loop/compare.mjs";
import { Refusal, decideScanner } from "./loop/decide.mjs";
import { readRecipes } from "./legacy/rescore.mjs";
import { decisionsPath, legacyFolderOf, loadRun } from "./score.mjs";

// The scanner loop's ledger (PLAN 4.8), where a change's record lives.
export const SCANNER_LEDGER = join(benchRoot, "index", "ledger", "scanner.jsonl");

function parseArgs(argv) {
  const o = { run: null, against: null, inputChange: null, release: null, out: null, decisions: decisionsPath, change: null, ledger: SCANNER_LEDGER, json: false };
  let last = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} takes a value`);
      return v;
    };
    if (a === "--json") o.json = true;
    else if (a === "--against") last = o.against = { run: value(), specs: null };
    else if (a === "--specs") {
      if (last === null) throw new Error("--specs follows the run it applies to");
      last.specs = value();
    } else if (a === "--input-change") o.inputChange = value();
    else if (a === "--decisions") o.decisions = resolve(value());
    else if (a === "--change") o.change = value();
    else if (a === "--ledger") o.ledger = resolve(value());
    else if (a === "--release") o.release = value();
    else if (a === "--out") o.out = value();
    else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else if (o.run === null) last = o.run = { run: a, specs: null };
    else throw new Error(`one run, then --against <baseline>; ${a} is a second run`);
  }
  if (o.run === null) throw new Error("name a run: a folder or a run id under benchmark/results");
  return o;
}

const folderOf = (run) => (existsSync(run) ? resolve(run) : join(resultsRoot, run));
const specsOf = (folder, specs) => (specs === null ? null : existsSync(specs) ? resolve(specs) : join(folder, specs));

// The class of each truth item a run's spec copy lacks it on, from the
// frozen planted case, where that case holds the same item at the same
// place (runs saved before the classes were written).
function withClasses(suite, specs) {
  if (suite !== "planted") return specs;
  const out = {};
  for (const [name, spec] of Object.entries(specs)) {
    let frozen = null;
    try {
      frozen = existsSync(join(casesRoot, name, "case.json")) ? readCase(name) : null;
    } catch {
      frozen = null;
    }
    const same = (a, b) => a && b.id === a.id && b.file === a.file && JSON.stringify(b.lines) === JSON.stringify(a.lines);
    out[name] = { ...spec, bugs: (spec.bugs ?? []).map((b) => (b.class !== undefined ? b : { ...b, class: (frozen?.bugs ?? []).find((f) => same(f, b))?.class ?? null })) };
  }
  return out;
}

// The lines each planted case's change touched, from the case built from
// the live tree, when the run recorded the case's hash and it is the live
// one; null otherwise (the tables then call reachability unknown).
function changedLinesOf(manifest) {
  const cache = new Map();
  const temps = [];
  const hashOf = (name) => manifest.caseHashes?.[name] ?? null;
  const hash8Of = (name) => (manifest.caseIds ?? []).map(parseCaseId).find((p) => p?.name === name)?.hash8 ?? null;
  const changedOf = (name) => {
    if (cache.has(name)) return cache.get(name);
    let changed = null;
    if ((manifest.suite ?? "planted") === "planted" && existsSync(join(casesRoot, name, "case.json"))) {
      try {
        const live = caseHash(name);
        const recorded = hashOf(name);
        if (recorded === live || (recorded === null && hash8Of(name) === live.slice(0, 8))) {
          const temp = mkdtempSync(join(tmpdir(), "oq-bench-scanners-"));
          temps.push(temp);
          changed = diffOf(buildCase(name, join(temp, "repo")).dir).changed;
        }
      } catch {
        changed = null;
      }
    }
    cache.set(name, changed);
    return changed;
  };
  return { changedOf, cleanup: () => temps.forEach((t) => rmSync(t, { recursive: true, force: true })) };
}

// The scanner toolchain record of a commit (lib/scanners.mjs
// toolchainRecord): its pinned table and lock files, read with git from
// this repository, the bytes toolchainHash() hashes. { error } when they
// cannot be read.
export function toolchainRecordAt(commit, root = repoRoot) {
  const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  let table;
  try {
    table = git("show", `${commit}:packages/scanners/toolchain.json`);
  } catch (e) {
    return { error: `the toolchain of ${commit} cannot be read from git here: ${String(e.stderr ?? e.message).trim().split("\n")[0]}` };
  }
  let names = [];
  try {
    names = git("ls-tree", "--name-only", `${commit}:packages/scanners/locks`).toString().split("\n").filter((f) => f.endsWith(".txt"));
  } catch {
    // A commit before the lock files: the hash covers the table alone.
  }
  return toolchainRecord({ table, locks: names.map((name) => ({ name, bytes: git("show", `${commit}:packages/scanners/locks/${name}`) })) });
}

// A run's build toolchain record, for a pin bump: from its build commit,
// unless the build is not that commit's tree.
function buildToolchain(manifest) {
  if (!manifest.external?.toolchainHash) return null;
  if (!manifest.build?.commit) return { error: "the run records no build commit" };
  if (manifest.build.dirty) return { error: "it was built from a tree its commit does not hold" };
  return toolchainRecordAt(manifest.build.commit);
}

function analyse({ run, specs }, { toolchain = false } = {}) {
  const folder = folderOf(run);
  const loaded = loadRun(folder, { specsDir: specsOf(folder, specs) });
  const { changedOf, cleanup } = changedLinesOf(loaded.manifest);
  try {
    const analysed = analyseRun({ name: basename(folder), manifest: loaded.manifest, attempts: loaded.attempts, specs: withClasses(loaded.manifest.suite ?? "planted", loaded.specs), changedOf, toolchain: toolchain ? buildToolchain(loaded.manifest) : null });
    return { folder, analysed, loaded, specsFrom: loaded.specsFrom ?? "the run's own cases/" };
  } finally {
    cleanup();
  }
}

const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round((100 * r.hit) / r.of)}%)` : ""}`;
const ms = (d) => (d.n === 0 ? "n/a" : `${Math.round(d.p50)} / ${Math.round(d.p90)} ms (${d.n})`);
const secs = (d) => (d.n === 0 ? "n/a" : `${(d.p50 / 1000).toFixed(1)} / ${(d.p90 / 1000).toFixed(1)} s (${d.n})`);
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const classes = (byClass) => DROP_CLASSES.filter((k) => byClass[k] > 0).map((k) => `${k} ${byClass[k]}`).join(", ") || "none";
const MISSING_TEXT = {
  selection: "selection (which files each scanner was handed): remits, misses and infra misses are unknown",
  trail: "trail (what each filter and dedup did to every raw finding): merged findings come from alsoReportedBy, filter losses are unknown, and a finding merged in a scan that predates alsoReportedBy is invisible, so unique and leave one out can overstate the scanner it went into",
  stages: "stages (what each filter removed per scanner): only raw and kept are known",
  resolveMs: "resolveMs (the time to find or install each tool)",
  files: "files (how many files each scanner was handed)",
  timings: "timings (the product's phase times): the scanner stage is read as the slowest scanner",
  submission: "submission.json (the reviewer's final answer): a candidate it raised and finalize hid reads as unanswered",
};

export function render(r, { specsFrom }) {
  const out = [];
  const t = r.totals;
  out.push(`# Scanners in ${r.run}`);
  out.push("");
  out.push(`Suite ${r.suite}, split ${r.split}, ${r.mode === "scan" ? "scanner-only" : "review"} run; ${r.population.scanned} of ${r.population.planned} planned samples saved a scan (each job's first attempt). Specs: ${specsFrom}. Scanner tables version ${SCANNERS_VERSION}.`);
  out.push(`Inputs: scanner toolchain ${r.toolchainHash ? r.toolchainHash.slice(0, 12) : "not recorded"}; Semgrep rule packs ${Array.isArray(r.semgrepRules) ? (r.semgrepRules.length === 0 ? "none consumed" : r.semgrepRules.map((p) => `${p.pack} ${p.sha256.slice(0, 12)}`).join(", ")) : r.semgrepRules}.`);
  for (const j of r.population.noScan) out.push(`- No scan for ${j.jobId}: ${j.why}.`);
  const missing = Object.entries(r.missing);
  if (missing.length > 0) {
    out.push("", "Not recorded by these scans (saved by an older build), so what depends on it is unknown, never guessed:");
    for (const [field, m] of missing) out.push(`- ${MISSING_TEXT[field]}: ${m.lacking} of ${m.of} samples.`);
  }
  out.push("", `Candidates: ${t.candidates} in ${t.samples} samples. ${r.mode === "scan" ? `${t.unreviewed} unreviewed (no reviewer ran).` : `${t.raised} raised by a shown finding, ${t.held} held (raised in the final answer, hidden by finalize under the confidence floor or below the severity threshold), ${t.dropped} dropped, ${t.unanswered} unanswered${t.unreviewed > 0 ? `, ${t.unreviewed} in reviews that saved no report` : ""}.`}`);

  const names = Object.keys(r.scanners);
  const notRun = (s) => Object.entries(s.samples.notRun).map(([k, n]) => `${k} ${n}`).join(", ") || "0";
  out.push("", "## Scanners: what each raised and what became of it", "");
  out.push(table(["Scanner", "Ran", "No files", "Not run", "Raw", "Removed: changed lines / fixtures / rules / merged", "Kept", "Raised", "Dropped", "Held / unanswered"], names.map((n) => {
    const s = r.scanners[n];
    const removed = s.samples.ran === 0 ? "n/a" : s.removed ? `${s.removed.changedLines} / ${s.removed.fixtures} / ${s.removed.rules} / ${s.removed.merged}` : `not recorded (raw less kept: ${s.raw - s.kept}${s.mergedAway > 0 ? `, of which ${s.mergedAway} merged` : ""})`;
    return [n, String(s.samples.ran), String(s.samples.noFiles), notRun(s), String(s.raw), removed, String(s.kept), String(s.raised), String(s.dropped), `${s.held} / ${s.unanswered}`];
  })));
  out.push("", "## Scanners: the truth they found", "");
  out.push("Found: a place of the scanner on a truth item's lines whose scanner the item expects or whose words name it (issue-level). Location only: any place on its lines. Counts are (sample, truth item) pairs; ratios are summed over samples.", "");
  out.push(table(["Scanner", "Found", "Unique", "Location only", "Precision of kept", "Location precision", "Raised precision", "Recall on remit", "Remit unknown", "Infra misses"], names.map((n) => {
    const s = r.scanners[n];
    return [n, String(s.found), String(s.unique), String(s.located), pct(s.precision), pct(s.locationPrecision), pct(s.raisedPrecision), pct(s.remit), String(s.remit.unknown), s.infraMisses === null ? `unknown (${s.infraUnknown} items)` : String(s.infraMisses)];
  })));
  out.push("", `Remit: ${r.classRemit}.`);
  if (r.mergedAtCandidateLines > 0) out.push(`${r.mergedAtCandidateLines} merged findings are placed at the lines of the candidate they went into, since the trail did not record their own (a scan before the trail, or a trail past its cap); found, unique and leave one out read them there.`);
  if (r.misses.length > 0) {
    out.push("", `Misses (in the remit, the scanner ran, and did not find it), ${r.misses.length}:`);
    for (const m of r.misses) out.push(`- ${m.scanner}: ${m.caseId} ${m.truth} (${m.class ?? "unclassed"}, ${m.file}) in ${m.sample}`);
  }
  if (r.filterLosses.length > 0) {
    out.push("", "Filter losses (a raw finding on a truth item that a filter removed):");
    for (const f of r.filterLosses) out.push(`- ${f.token} on ${f.caseId} ${f.truth}, removed at ${f.stage}, in ${f.sample}`);
  }

  out.push("", "## Rules, by kept candidates", "");
  out.push(`Default-off bar: at least ${RULE_OFF.minKept} kept, at least ${Math.round(RULE_OFF.dropShare * 100)}% dropped, from at least ${RULE_OFF.minRepos} repositories (cases, on planted suites), and no truth item found. Planted evidence alone is provisional.`, "");
  out.push(table(["Rule", "Kept", "Merged", "Raised", "Dropped", "Dropped by class", "Found", "Unique", "Repos", "Default-off bar"], r.rules.map((x) => [x.token, String(x.kept), String(x.merged), String(x.raised), String(x.dropped), classes(x.dropsByClass), String(x.found), String(x.unique), String(x.repos), x.defaultOff ? "meets it" : ""])));

  out.push("", "## Drop classes", "");
  const d = r.drops;
  out.push(table(["Class", "Drops", "Share", "Points at"], DROP_CLASSES.map((k) => [k, String(d.byClass[k]), d.total === 0 ? "0%" : `${Math.round((100 * d.byClass[k]) / d.total)}%`, POINTS_AT[k]])));
  const tags = Object.entries(d.byTag);
  out.push("", `${d.total} drops. Tags: ${tags.length === 0 ? "none" : tags.map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  if (d.ruleFpByRule.length > 0) out.push(`Rule false positives by rule: ${d.ruleFpByRule.map((x) => `${x.token} ${x.drops}`).join(", ")}.`);

  out.push("", "## Gaps, by language and class", "");
  out.push("Distinct truth items (a case's item once, found when any sample found it). A language scanner is any scanner but semgrep, gitleaks and OpenQodex's own candidates.", "");
  const unknown = (v) => (v === null ? "unknown" : String(v));
  out.push(table(["Language", "Class", "Items", "Reachable", "Found by a language scanner", "Only semgrep or gitleaks", "Found by none", "In a language scanner's remit"], r.gaps.map((g) => [g.language, g.class, String(g.items), unknown(g.reachable), String(g.foundLanguageScanner), String(g.foundGenericOnly), String(g.foundNone), unknown(g.inLanguageRemit)])));
  out.push("", `A language is a gap with at least ${GAP.minItems} reachable items (or ${Math.round(GAP.minShare * 100)}% of the run's) when no language scanner has one in its remit, or they find under ${Math.round(GAP.minRecall * 100)}% of those in it.${r.suite === "planted" ? " On planted cases a verdict is provisional: gaps are decided on the real pull requests of the development split." : ""}`);
  for (const l of r.languages) out.push(`- ${l.language}: ${l.gap === null ? "unknown" : l.gap ? "a gap" : "no gap"}; ${l.why}.`);

  const tm = r.time;
  out.push("", "## Time", "");
  out.push(table(["Measure", "p50 / p90 (samples)"], [
    ["Wall time per sample", secs(tm.wallMs)],
    ["Reviewer", secs(tm.reviewerMs)],
    ["Reviewer share of summed wall time", tm.reviewerShare.of === 0 ? "n/a" : `${Math.round((100 * tm.reviewerShare.hit) / tm.reviewerShare.of)}% (${Math.round(tm.reviewerShare.hit / 1000)} of ${Math.round(tm.reviewerShare.of / 1000)} s)`],
    ["Scanner stage: the slowest scanner", ms(tm.slowestScannerMs)],
    ["Scanner stage: scan_ms (recorded)", ms(tm.scanMs)],
    ["Scan stage over the slowest scanner", tm.stageOverSlowest === null ? "not recorded" : `${tm.stageOverSlowest.p50.toFixed(2)} / ${tm.stageOverSlowest.p90.toFixed(2)} (${tm.stageOverSlowest.n}); ${tm.stageOverSlowest.over115} samples over 1.15`],
    ["Graph", ms(tm.graphMs)],
    [`Rest (wall less reviewer, graph and ${tm.restFrom})`, ms(tm.restMs)],
    ["Candidates per sample", `${tm.candidatesPerSample.candidates} in ${tm.candidatesPerSample.samples} (${tm.candidatesPerSample.samples === 0 ? "n/a" : (tm.candidatesPerSample.candidates / tm.candidatesPerSample.samples).toFixed(1)})`],
  ]));
  out.push("", `Slowest scanner per sample: ${Object.entries(tm.slowest).map(([n, k]) => `${n} in ${k} of ${tm.samples}`).join(", ") || "none ran"}.`, "");
  const timed = names.filter((n) => r.scanners[n].ms.n > 0).sort((a, b) => r.scanners[b].ms.p50 - r.scanners[a].ms.p50 || (a < b ? -1 : 1));
  out.push(table(["Scanner", "Ran in", "p50 / p90 ms", "Max ms", "Resolve p50 ms", "Slowest in"], timed.map((n) => {
    const s = r.scanners[n];
    return [n, String(s.ms.n), `${Math.round(s.ms.p50)} / ${Math.round(s.ms.p90)}`, String(Math.round(s.ms.max)), s.resolveMs.n === 0 ? "not recorded" : `${Math.round(s.resolveMs.p50)} (${s.resolveMs.n})`, String(s.slowestIn)];
  })));

  out.push("", "## Leave one out", "");
  out.push("Without the scanner: the truth items no other scanner found (a finding dedup merged into its candidates comes back and keeps its own scanner's credit), and the kept candidates saved (those that absorbed no other scanner's finding).", "");
  out.push(table(["Scanner", "Items lost", "Candidates saved", "Lost"], names.filter((n) => r.scanners[n].kept > 0 || r.scanners[n].found > 0).map((n) => {
    const l = r.scanners[n].leaveOneOut;
    return [n, String(l.lost.length), String(l.candidatesSaved), l.lost.map((x) => `${x.caseId} ${x.truth} (${x.samples})`).join("; ") || "none"];
  })));
  return out.join("\n");
}

const placeText = (c) => `${c.ref}: ${c.caseId} ${c.file} ${c.lines[0] === c.lines[1] ? `line ${c.lines[0]}` : `lines ${c.lines[0]} to ${c.lines[1]}`}, ${c.token}${c.samples > 1 ? ` (${c.samples} samples)` : ""}`;

// K2 to K4 as the acceptance rule (decideScanner) read them.
function renderAcceptance(a) {
  const out = ["", `### K2 to K4, by ${ACCEPTANCE_RULE}${a.change ? ` for ${a.change}` : ""}`, ""];
  const k2 = a.k2;
  out.push(`The change removes ${k2.removed} ${k2.removed === 1 ? "candidate" : "candidates"} and adds or alters ${k2.added}.`);
  const groups = [
    ["Frozen false (a clean control), no ruling needed", k2.frozenFalse],
    ["Ruled false by a person", k2.ruledFalse],
    ["Ruled a real issue by a person", k2.ruledTrue],
    ["Awaiting a person's ruling (a reviewer's drop does not count)", k2.pending],
    ["Frozen true (a hit on a truth item or a listed side issue)", k2.frozenTrue],
  ];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    out.push(`${label}, ${list.length}:`);
    for (const c of list) out.push(`- ${placeText(c)}${(c.refused ?? []).map((x) => `; the ruling on line ${x.line} of the adjudication file does not count: ${x.why}`).join("")}`);
  }
  if (a.k3) {
    const r = a.k3.redundancy;
    out.push(`K3: redundant candidates per case ${r.pass ? "rise in no case" : `rise in ${r.rose.map((x) => `${x.caseId} (${x.parent} then ${x.candidate})`).join(", ")}`} (their share of all candidates, a diagnostic only: ${r.share.parent.hit}/${r.share.parent.of} then ${r.share.candidate.hit}/${r.share.candidate.of}). Recall, critical and major recall, precision with the rulings, and clean-control candidates: ${Object.entries(a.k3.cases).filter(([, c]) => !c.pass).map(([g, c]) => `${g} worse in ${c.worse.map((w) => w.caseId).join(", ")}`).join("; ") || "no case worse"}.`);
    const t = a.k3.time;
    out.push(t.measured ? `Median scan time ${Math.round(t.parent)} then ${Math.round(t.candidate)} ms (${t.change >= 0 ? "+" : ""}${(t.change * 100).toFixed(1)} percent), ${t.pass ? "inside" : "not inside"} its ${(t.loss * 100).toFixed(0)} percent.` : "Median scan time not measured: a sample recorded no scan_ms.");
  }
  out.push(`K4 (a review run on both paths, three repeats): ${a.k4.required ? "required" : "not required"}; ${a.k4.pass === null ? "not run" : a.k4.pass ? `passed (${a.k4.runId ?? "no run named"})` : `did not pass (${a.k4.runId ?? "no run named"})`}.`);
  out.push("", `Decision: ${a.reason}`);
  return out.join("\n");
}

function renderJudgement(j, base, cand, inputChange, acceptance = null) {
  const out = ["", `## Against ${base.name}`, ""];
  if (j.exit === 2) {
    out.push(`Refused: ${cand.name} cannot be judged against ${base.name}:`);
    for (const why of j.refusals) out.push(`- ${why}`);
    return out.join("\n");
  }
  if (inputChange) out.push(`The change under test: ${inputChange}.`);
  if (j.k1.pass) out.push(`K1 holds: every one of the ${j.k1.checked} truth items ${base.name} found with issue-level evidence is still found in every sample.`);
  else {
    out.push(`K1 fails: ${j.k1.lost.length} of the ${j.k1.checked} truth items ${base.name} found with issue-level evidence ${j.k1.lost.length === 1 ? "is" : "are"} lost:`);
    for (const x of j.k1.lost) out.push(`- ${x.caseId} ${x.truth}: found before by ${x.foundBefore.join(", ")}; now ${x.locatedNow.length === 0 ? "nothing sits on its lines" : `only a location match by ${x.locatedNow.join(", ")}, which is not coverage of this issue`}.`);
  }
  if (acceptance) out.push(renderAcceptance(acceptance));
  return out.join("\n");
}

// The record of a change: its latest line in the scanner ledger.
function recordOf(ledger, id) {
  if (!existsSync(ledger)) throw new Error(`the scanner ledger ${ledger} does not exist, so it holds no ${id}`);
  const lines = readFileSync(ledger, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const line = lines.filter((l) => l.id === id).at(-1);
  if (!line) throw new Error(`the scanner ledger ${ledger} holds no ${id}`);
  return line;
}

function main() {
  let o;
  let run;
  let base = null;
  try {
    o = parseArgs(process.argv.slice(2));
    if (o.inputChange !== null && o.against === null) throw new Error("--input-change names the change a comparison allows; it needs --against");
    if (o.change !== null && o.against === null) throw new Error("--change names the change a comparison decides; it needs --against");
    if (o.inputChange !== null && !/^pin-bump:.+$/.test(o.inputChange) && o.inputChange !== "semgrep-packs") throw new Error(`--input-change takes ${INPUT_CHANGES}`);
    run = analyse(o.run, { toolchain: o.against !== null });
    if (o.against) base = analyse(o.against, { toolchain: true });
  } catch (e) {
    process.stderr.write(`scanners: ${e.message}\n`);
    return 2;
  }
  const refusals = runRefusals(run.analysed, { release: o.release });
  if (refusals.length > 0) {
    process.stderr.write(`scanners: refused: ${refusals.join("; ")}\n`);
    return 2;
  }
  const report = scannerReport(run.analysed);
  const judgement = base ? judgeAgainst(base.analysed, run.analysed, { inputChange: o.inputChange }) : null;
  // K2 to K4: the acceptance rule's, through the seam, once K1 is read.
  let acceptance = null;
  if (judgement && judgement.exit !== 2) {
    try {
      const record = o.change === null ? null : recordOf(o.ledger, o.change);
      const d = readRulings(o.decisions);
      acceptance = decideScanner({ base: scanSide({ loaded: base.loaded, runId: base.analysed.name }), cand: scanSide({ loaded: run.loaded, runId: run.analysed.name }), k1: judgement.k1, rulings: { lines: d.lines, people: d.people }, record });
    } catch (e) {
      process.stderr.write(`scanners: refused: ${e instanceof Refusal ? e.message : e.stack}\n`);
      return 2;
    }
  }
  const exit = judgement === null ? 0 : judgement.exit === 2 ? 2 : acceptance.decision === "revert" ? 1 : 0;
  const doc = { ...report, specsFrom: run.specsFrom, comparedWith: base ? { run: base.analysed.name, inputChange: o.inputChange, exit, refusals: judgement.refusals, k1: judgement.k1, acceptanceRule: ACCEPTANCE_RULE, acceptance } : null };
  // A legacy run's folder is the published original: its scanners.json goes only to --out.
  const dest = o.out === null ? run.folder : resolve(o.out);
  const legacy = legacyFolderOf(dest, readRecipes());
  let saved = null;
  if (legacy === null) {
    mkdirSync(dest, { recursive: true });
    saved = join(dest, "scanners.json");
    writeFileSync(saved, `${JSON.stringify(doc, null, 2)}\n`);
  }
  if (o.json) process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  else {
    process.stdout.write(`${render(report, { specsFrom: run.specsFrom })}\n`);
    if (base) process.stdout.write(`${renderJudgement(judgement, base.analysed, run.analysed, o.inputChange, acceptance)}\n`);
    process.stdout.write(`\n${saved ? `Saved ${saved}.` : `scanners.json not written: ${dest} is, or lies in, the published folder of the legacy run ${legacy}; name another folder with --out.`}\n`);
  }
  return exit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
