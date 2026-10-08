#!/usr/bin/env node
// Scores a saved benchmark run, from its files only, and compares it with
// an earlier run when asked:
//
//   node benchmark/score.mjs <results folder> [--against <earlier folder>] [--json]
//
// Prints markdown tables (or, with --json, the summary as JSON) and writes
// score.json into the results folder. The exit code is information, never a
// gate on its own: 0 scored, 1 the comparison shows a regression (a bug
// missed in two or more samples that the earlier run found more often, or
// more clean changes with findings), 2 the folder cannot be scored.
//
// Failure list, written before the code (the matching rules and their own
// failure list are in lib/score.mjs):
// 1. A sample folder without sample.json (a review the run did not finish)
//    is scored as a failed review: it is left out and counted as not run;
//    a review that ran and wrote no report is scored as failed.
// 2. The specs of today are used for an old run: the specs come from the
//    run's own cases/ folder; a case missing there stops the scoring.
// 3. Two runs with different models or case sets are compared as builds:
//    every difference is printed above the comparison.
// 4. A table hides how many samples a number rests on: every ratio is
//    printed as hits/checks, every time and cost with its count.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SEVERITY_ORDER, bugStability, groupBy, regressions, runDifferences, scoreSample, summarize, value } from "./lib/score.mjs";

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

export function loadRun(folder) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const specs = {};
  const samples = [];
  let notRun = 0;
  for (const c of dirs(join(folder, "samples"))) {
    const spec = readJson(join(folder, "cases", `${c}.json`));
    if (!spec) throw new Error(`${folder}/cases/${c}.json is missing; the run's own spec is needed to score it`);
    specs[c] = spec;
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        const row = readJson(join(dir, "sample.json"));
        if (!row) {
          notRun++;
          continue;
        }
        const report = readJson(join(dir, "report", "report.json"));
        const brief = readText(join(dir, "report", "brief.md"));
        samples.push(scoreSample({ spec, report, brief, row }));
      }
    }
  }
  return { folder, manifest, specs, samples, notRun };
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
    run: run.folder,
    build: run.manifest.build,
    reviewer: run.manifest.reviewer ?? run.manifest.reviewers,
    repeat: run.manifest.repeat,
    planned: run.manifest.planned,
    saved: run.samples.length,
    notRun: run.notRun,
    ended: run.manifest.ended,
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
  out.push(`Build ${s.build?.short} (openqodex ${s.build?.cliVersion}${s.build?.dirty ? ", uncommitted source changes" : ""}); reviewer ${s.reviewer?.name ?? ""} ${s.reviewer?.version ?? ""}, model ${JSON.stringify(model)}; ${s.saved} of ${s.planned} reviews saved${s.ended?.how === "stopped" ? `; the run stopped: ${s.ended.why}` : ""}.`);
  out.push("");
  const rows = [
    ["Planted bugs found (recall)", (c) => pct(c.recall)],
    ...SEVERITY_ORDER.filter((k) => configs.some((c) => s.byConfig[c].bySeverity[k].of > 0)).map((k) => [`  ${k}`, (c) => pct(c.bySeverity[k])]),
    ["Findings that are planted bugs (precision)", (c) => pct(c.precision)],
    ["False findings", (c) => String(c.falseFindings)],
    ["  of them near misses / wrong kind", (c) => `${c.nearMisses} / ${c.wrongKinds}`],
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

export function renderCompare(older, newer, regs) {
  const out = [];
  const diffs = runDifferences(older.manifest, newer.manifest);
  out.push(`Comparing ${older.folder} (build ${older.manifest.build?.short}) with ${newer.folder} (build ${newer.manifest.build?.short}).`);
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
  let json = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--against") against = args[++i];
    else if (args[i] === "--json") json = true;
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || (against !== null && against === undefined)) {
    console.error("usage: node benchmark/score.mjs <results folder> [--against <earlier results folder>] [--json]");
    process.exit(2);
  }
  let run;
  let older = null;
  try {
    run = loadRun(resolve(pos[0]));
    if (against) older = loadRun(resolve(against));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const s = summary(run);
  const regs = older ? regressions(older.samples, run.samples) : [];
  const doc = { ...s, comparedWith: older ? { run: older.folder, build: older.manifest.build, differences: runDifferences(older.manifest, run.manifest), regressions: regs } : null };
  writeFileSync(join(run.folder, "score.json"), `${JSON.stringify(doc, null, 2)}\n`);
  if (json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(render(s));
    if (older) console.log(`\n${renderCompare(older, run, regs)}`);
    console.log(`\nSummary saved: ${join(run.folder, "score.json")}`);
  }
  process.exit(regs.length > 0 ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) main();
