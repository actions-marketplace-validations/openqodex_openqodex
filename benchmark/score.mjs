#!/usr/bin/env node
// Scores a saved benchmark run, from its files only, and compares it with
// an earlier run when asked:
//
//   node benchmark/score.mjs <results folder> [--against <earlier folder>]
//                            [--specs <folder of <case>.json>] [--json]
//
// The specs are the run's own copies (cases/ in the run). --specs scores the
// saved reviews against other specs, such as an amended copy; the output and
// score.json then name that folder and every case whose spec differs from
// the run's own. No review is run again either way.
//
// Prints markdown tables (or, with --json, the summary as JSON) and writes
// score.json into the results folder. The exit code is information, never a
// gate on its own: 0 scored, 1 the comparison shows a regression (a bug
// missed in two or more samples that the earlier run found more often, or
// more clean changes with findings), 2 the folder cannot be scored.
//
// Failure list, written before the code (the matching rules and their own
// failure list are in lib/score.mjs):
// 1. A review leaves no row and the run looks better than it was: every
//    attempt folder is scored, a failed or stopped one as a failure, and one
//    the runner never finished recording (no sample.json) as a failure too,
//    counted apart as unrecorded.
// 2. The specs of today are used for an old run without saying so: the
//    specs come from the run's own cases/ folder unless --specs names
//    another, and then every difference is printed and saved.
// 3. A spec that breaks the matching rules (a plant without its words) is
//    scored anyway: every spec is checked first, and one that fails stops
//    the scoring with its problems.
// 4. Two runs with different models or case sets are compared as builds:
//    every difference is printed above the comparison.
// 5. A table hides how many samples a number rests on: every ratio is
//    printed as hits/checks, every time and cost with its count.
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, specProblems } from "./lib/cases.mjs";
import { SEVERITY_ORDER, bugStability, groupBy, regressions, runDifferences, scoreSample, specDifferences, summarize, value } from "./lib/score.mjs";

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};
const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const dirs = (path) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);

export function loadRun(folder, { specsDir = null } = {}) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const from = specsDir ?? join(folder, "cases");
  const specs = {};
  const ownSpecs = {};
  const problems = [];
  const samples = [];
  let unrecorded = 0;
  for (const c of dirs(join(folder, "samples"))) {
    const spec = readJson(join(from, `${c}.json`));
    if (!spec) throw new Error(`${join(from, `${c}.json`)} is missing; a spec is needed to score ${c}`);
    problems.push(...specProblems(spec, c));
    specs[c] = spec;
    ownSpecs[c] = readJson(join(folder, "cases", `${c}.json`));
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        let row = readJson(join(dir, "sample.json"));
        // An attempt the runner never finished recording is still a review that happened.
        if (!row) {
          unrecorded++;
          const [repeat, attempt] = n.split("-attempt");
          row = { case: c, config, repeat: Number(repeat), attempt: attempt === undefined ? 1 : Number(attempt), unrecorded: true };
        }
        const report = readJson(join(dir, "report", "report.json"));
        const brief = readText(join(dir, "report", "brief.md"));
        samples.push(scoreSample({ spec, report, brief, row }));
      }
    }
  }
  if (problems.length > 0) throw new Error(`the specs in ${from} cannot be scored with:\n${problems.join("\n")}${specsDir ? "" : "\nScore against amended specs with --specs <folder>."}`);
  const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const specsDiffer = specsDir ? Object.keys(specs).filter((c) => JSON.stringify(specs[c]) !== JSON.stringify(ownSpecs[c])) : [];
  // Shown and saved relative to the repository when the run lies in it, so no machine path is published.
  const inside = relative(repoRoot, folder);
  const name = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : folder;
  const specsName = specsDir === null ? null : (() => {
    const r = relative(repoRoot, specsDir);
    return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : specsDir;
  })();
  return { folder, name, manifest, specs, samples, unrecorded, resumes, specsFrom: specsName, specsDiffer };
}

const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round(value(r) * 100)}%)` : ""}`;
const secs = (s) => (s.n === 0 ? "n/a" : `${(s.mean / 1000).toFixed(0)} s`);
const usd = (s) => (s.n === 0 ? "n/a" : `$${s.mean.toFixed(2)}`);
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

export function summary(run) {
  const byConfig = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) byConfig[config] = summarize(samples);
  const byCase = {};
  for (const [key, samples] of groupBy(run.samples, (s) => `${s.case}\0${s.config}`)) {
    const [c, config] = key.split("\0");
    byCase[c] ??= {};
    byCase[c][config] = summarize(samples);
  }
  const stability = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) stability[config] = bugStability(samples);
  const briefFailures = {};
  for (const [config, samples] of groupBy(run.samples, (s) => s.config)) {
    const seen = new Map();
    for (const s of samples) for (const f of s.failures) seen.set(`${s.case}: ${f}`, (seen.get(`${s.case}: ${f}`) ?? 0) + 1);
    briefFailures[config] = [...seen].map(([what, n]) => ({ what, samples: n }));
  }
  const falseFindings = run.samples.flatMap((s) => s.findings.filter((f) => ["false", "near", "wrong-kind"].includes(f.outcome)).map((f) => ({ case: s.case, config: s.config, repeat: s.repeat, outcome: f.outcome, file: f.file, line: f.line, category: f.category, severity: f.severity, title: f.title, bug: f.bug ?? null, distance: f.distance ?? null })));
  return {
    run: run.name,
    build: run.manifest.build,
    reviewer: run.manifest.reviewer ?? run.manifest.reviewers,
    repeat: run.manifest.repeat,
    planned: run.manifest.planned,
    saved: run.samples.length,
    secondAttempts: run.samples.filter((x) => x.attempt > 1).length,
    unrecorded: run.unrecorded,
    ended: run.manifest.ended,
    resumes: run.resumes,
    specsFrom: run.specsFrom ?? "the run's own cases/",
    specsDiffer: run.specsDiffer,
    byConfig,
    byCase,
    stability,
    briefFailures,
    falseFindings,
  };
}

export function render(s) {
  const configs = Object.keys(s.byConfig).sort();
  const out = [];
  const model = s.reviewer?.model ?? (s.reviewer && typeof s.reviewer === "object" ? Object.values(s.reviewer).map((r) => `${r.name} ${JSON.stringify(r.model)}`).join(", ") : "unknown");
  out.push(`Run ${s.run}`);
  const lastEnd = [...(s.resumes ?? [])].reverse().find((r) => r.event === "ended") ?? s.ended;
  out.push(`Build ${s.build?.short} (openqodex ${s.build?.cliVersion}${s.build?.dirty ? ", built from a tree the commit does not hold" : ""}); reviewer ${s.reviewer?.name ?? ""} ${s.reviewer?.version ?? ""}, model ${JSON.stringify(model)}; ${s.saved} attempts saved for ${s.planned} planned reviews (${s.secondAttempts} second attempts, ${s.unrecorded} unrecorded)${lastEnd?.how === "stopped" ? `; the run stopped: ${lastEnd.why}` : ""}.`);
  if (s.specsFrom !== "the run's own cases/") out.push(`Scored against the specs in ${s.specsFrom}, not the run's own; they differ for: ${s.specsDiffer.join(", ") || "no case"}.`);
  out.push("");
  const rows = [
    ["Planted bugs found (recall)", (c) => pct(c.recall)],
    ...SEVERITY_ORDER.filter((k) => configs.some((c) => s.byConfig[c].bySeverity[k].of > 0)).map((k) => [`  ${k}`, (c) => pct(c.bySeverity[k])]),
    ["Findings that are planted bugs (precision)", (c) => pct(c.precision)],
    ["False findings", (c) => String(c.falseFindings)],
    ["Near misses / wrong kind (not hits either)", (c) => `${c.nearMisses} / ${c.wrongKinds}`],
    ["Duplicate hits on a bug already found (not counted)", (c) => String(c.duplicates)],
    ["Accepted side issues (not counted)", (c) => String(c.accepted)],
    ["Findings that only ask for a test (not counted)", (c) => String(c.testGaps)],
    ["Clean changes with no finding", (c) => pct(c.controls)],
    ["Graph gaps disclosed in the brief", (c) => pct(c.gaps)],
    ["Callers listed in the brief", (c) => pct(c.callers)],
    ["Reviews complete / incomplete / failed", (c) => `${c.complete} / ${c.incomplete} / ${c.failed}`],
    ["Time per review, mean (median)", (c) => (c.wallMs.n === 0 ? "n/a" : `${secs(c.wallMs)} (${(c.wallMs.median / 1000).toFixed(0)} s)`)],
    ["Reviewer time per review, mean", (c) => secs(c.reviewerMs)],
    ["Cost per review, mean", (c) => usd(c.costUsd)],
    ["Cost, total", (c) => (c.costUsd.n === 0 ? "n/a" : `$${c.costUsd.total.toFixed(2)}`)],
    ["Reviewer turns per review, mean", (c) => (c.turns.n === 0 ? "n/a" : c.turns.mean.toFixed(1))],
    ["Tokens in / out per review, mean", (c) => (c.inputTokens.n === 0 ? "n/a" : `${Math.round(c.inputTokens.mean / 1000)}k / ${Math.round(c.outputTokens.mean / 1000)}k`)],
  ];
  out.push(table(["Measure", ...configs], rows.map(([label, f]) => [label, ...configs.map((c) => f(s.byConfig[c]))])));
  out.push("");
  out.push("Per case (recall; false findings; mean time; mean cost):");
  out.push("");
  out.push(
    table(
      ["Case", ...configs],
      Object.keys(s.byCase)
        .sort()
        .map((c) => [c, ...configs.map((cfg) => {
          const x = s.byCase[c][cfg];
          if (!x) return "n/a";
          const gaps = x.gaps.of + x.callers.of > 0 ? `; graph ${x.gaps.hit + x.callers.hit}/${x.gaps.of + x.callers.of}` : "";
          return `${x.controls.of > 0 ? `clean ${pct(x.controls)}` : pct(x.recall)}; ${x.falseFindings} false${gaps}; ${secs(x.wallMs)}; ${usd(x.costUsd)}`;
        })]),
    ),
  );
  out.push("");
  const missed = configs.flatMap((cfg) => s.stability[cfg].filter((b) => b.found < b.of).map((b) => ({ cfg, ...b })));
  if (missed.length > 0) {
    out.push("Planted bugs not found in every review:");
    out.push("");
    out.push(table(["Configuration", "Case", "Bug", "Severity", "Found", "Near miss", "Wrong kind", "Candidate dropped"], missed.map((b) => [b.cfg, b.case, b.bug, b.severity, `${b.found}/${b.of}`, String(b.near), String(b.wrongKind), String(b.dropped)])));
    out.push("");
  }
  for (const cfg of configs) {
    if (s.briefFailures[cfg].length === 0) continue;
    out.push(`What the brief did not say (${cfg}):`);
    for (const f of s.briefFailures[cfg]) out.push(`- ${f.what} (${f.samples} reviews)`);
    out.push("");
  }
  return out.join("\n");
}

// Everything besides the build that differs between two runs.
export function differences(older, newer) {
  return [...runDifferences(older.manifest, newer.manifest), ...specDifferences(older.specs, newer.specs)];
}

export function renderCompare(older, newer, regs) {
  const out = [];
  const diffs = differences(older, newer);
  out.push(`Comparing ${older.name} (build ${older.manifest.build?.short}) with ${newer.name} (build ${newer.manifest.build?.short}).`);
  if (diffs.length > 0) {
    out.push("These differ besides the build, so a change below may not be the product's:");
    for (const d of diffs) out.push(`- ${d}`);
  }
  out.push("");
  const so = summary(older);
  const sn = summary(newer);
  const configs = [...new Set([...Object.keys(so.byConfig), ...Object.keys(sn.byConfig)])].sort();
  const cell = (s, cfg, f) => (s.byConfig[cfg] ? f(s.byConfig[cfg]) : "n/a");
  const rows = [];
  for (const cfg of configs) {
    rows.push([cfg, "recall", cell(so, cfg, (c) => pct(c.recall)), cell(sn, cfg, (c) => pct(c.recall))]);
    rows.push([cfg, "precision", cell(so, cfg, (c) => pct(c.precision)), cell(sn, cfg, (c) => pct(c.precision))]);
    rows.push([cfg, "clean controls", cell(so, cfg, (c) => pct(c.controls)), cell(sn, cfg, (c) => pct(c.controls))]);
    rows.push([cfg, "graph gaps", cell(so, cfg, (c) => pct(c.gaps)), cell(sn, cfg, (c) => pct(c.gaps))]);
    rows.push([cfg, "time per review", cell(so, cfg, (c) => secs(c.wallMs)), cell(sn, cfg, (c) => secs(c.wallMs))]);
    rows.push([cfg, "cost per review", cell(so, cfg, (c) => usd(c.costUsd)), cell(sn, cfg, (c) => usd(c.costUsd))]);
  }
  out.push(table(["Configuration", "Measure", `Before (${older.manifest.build?.short})`, `After (${newer.manifest.build?.short})`], rows));
  out.push("");
  if (regs.length === 0) out.push("No regression: no planted bug is missed in two or more reviews more often than before.");
  else {
    out.push("Regressions (missed in two or more reviews, more often than before):");
    for (const r of regs) out.push(`- ${r.config} ${r.case} ${r.bug}: found ${r.before} before, ${r.after} after`);
  }
  return out.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  let against = null;
  let specsDir = null;
  let json = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--against") against = args[++i];
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--specs") specsDir = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || against === undefined || specsDir === undefined) {
    console.error("usage: node benchmark/score.mjs <results folder> [--against <earlier results folder>] [--specs <folder of <case>.json>] [--json]");
    process.exit(2);
  }
  let run;
  let older = null;
  try {
    run = loadRun(resolve(pos[0]), { specsDir: specsDir === null ? null : resolve(specsDir) });
    if (against) older = loadRun(resolve(against));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const s = summary(run);
  const regs = older ? regressions(older.samples, run.samples) : [];
  const doc = { ...s, comparedWith: older ? { run: older.name, build: older.manifest.build, differences: differences(older, run), regressions: regs } : null };
  // Scored against other specs, the summary gets its own file, so the score
  // against the run's own specs is never overwritten.
  const outName = specsDir === null ? "score.json" : `score-${basename(resolve(specsDir))}.json`;
  writeFileSync(join(run.folder, outName), `${JSON.stringify(doc, null, 2)}\n`);
  if (json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(render(s));
    if (older) console.log(`\n${renderCompare(older, run, regs)}`);
    console.log(`\nSummary saved: ${join(run.name, outName)}`);
  }
  process.exit(regs.length > 0 ? 1 : 0);
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
