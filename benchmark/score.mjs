#!/usr/bin/env node
// Scores a saved benchmark run, from its files only, and compares it with
// an earlier run when asked:
//
//   node benchmark/score.mjs <results folder> [--against <earlier folder>]
//                            [--specs <folder of <case>.json>] [--out <folder>] [--json]
//
// The specs are the run's own copies (cases/ in the run). --specs scores the
// saved reviews against other specs, such as an amended copy; the output and
// the score file then name that folder and every case whose spec differs
// from the run's own. No review is run again either way.
//
// Writes score format 3: score.json (the population of planned first
// attempts, issue recall, precision as bounds, unique-issue precision,
// redundancy, the location and planted-rule blocks, per-case ratios, per-bug
// results and the rules block) and outcomes.jsonl (one line per finding of
// every first attempt), into the results folder or --out. A legacy run (one
// with a recipe in benchmark/legacy/recipes.json) keeps the score its own
// scorer wrote: its folder is the published original, so its format 3 score
// is written only with --out. Prints markdown tables (or, with --json, the
// score as JSON). The exit code is information, never a gate on its own: 0
// scored, 1 the comparison shows a regression (a bug missed in two or more
// reviews that the earlier run found more often, or more clean changes with
// findings), 2 the folder cannot be scored.
//
// Failure list, written before the code (the matching rules and their own
// failure list are in lib/score.mjs):
// 1. A review leaves no row and the run looks better than it was: every
//    attempt folder is read, and one the runner never finished recording
//    (no sample.json) is a review that happened, counted apart as
//    unrecorded; a planned review with no folder at all is unstarted and
//    counts as a miss (format 3).
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
// 6. A legacy run's published folder is written over, so it stops being
//    the original its index entry names: a legacy run is scored only with
//    --out, into another folder.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchRoot, parseCaseId, repoRoot, specProblems } from "./lib/cases.mjs";
import { ALL_ATTEMPTS_LABEL, RULES, bugStability, caseSetHash, groupBy, originOf, population, ratio, regressions, runDifferences, scoreJob, scoreSample, specDifferences, summarize, summarizeJobs, value } from "./lib/score.mjs";
import { readRecipes } from "./legacy/rescore.mjs";

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
const add = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

// The cases a run planned, by name: the manifest's case list, and the cases
// its `jobs` name.
function plannedCases(manifest) {
  const names = new Set(manifest.cases ?? []);
  for (const j of manifest.jobs ?? []) names.add(parseCaseId(j.caseId)?.name ?? j.caseId);
  return [...names];
}

export function loadRun(folder, { specsDir = null } = {}) {
  const manifest = readJson(join(folder, "manifest.json"));
  if (!manifest) throw new Error(`${folder} has no manifest.json; it is not a benchmark run`);
  const from = specsDir ?? join(folder, "cases");
  const specs = {};
  const ownSpecs = {};
  const problems = [];
  const samples = [];
  const attempts = [];
  let unrecorded = 0;
  const specOf = (c) => {
    if (specs[c]) return specs[c];
    const spec = readJson(join(from, `${c}.json`));
    if (!spec) throw new Error(`${join(from, `${c}.json`)} is missing; a spec is needed to score ${c}`);
    // The matching rules only: the scorer reads no label, and runs made before the freeze saved specs without them.
    problems.push(...specProblems(spec, c, { labels: false }));
    specs[c] = spec;
    ownSpecs[c] = readJson(join(folder, "cases", `${c}.json`));
    return spec;
  };
  for (const c of dirs(join(folder, "samples"))) {
    const spec = specOf(c);
    for (const config of dirs(join(folder, "samples", c))) {
      for (const n of dirs(join(folder, "samples", c, config))) {
        const dir = join(folder, "samples", c, config, n);
        // The folder says which job and which attempt this is: <repeat>, or <repeat>-attempt<n> for a retry.
        const [repeat, attempt] = n.split("-attempt").map(Number);
        let row = readJson(join(dir, "sample.json"));
        // An attempt the runner never finished recording is still a review that happened.
        if (!row) {
          unrecorded++;
          row = { case: c, config, repeat, attempt: attempt || 1, unrecorded: true };
        }
        const report = readJson(join(dir, "report", "report.json"));
        const brief = readText(join(dir, "report", "brief.md"));
        const sample = scoreSample({ spec, report, brief, row });
        samples.push(sample);
        attempts.push({ case: c, config, repeat, attempt: attempt || 1, row, report, brief, sample });
      }
    }
  }
  // A planned case with no folder at all still needs its spec: its jobs never started, and miss its bugs.
  for (const c of plannedCases(manifest)) specOf(c);
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
  return { folder, name, manifest, specs, samples, attempts, unrecorded, resumes, specsFrom: specsName, specsDiffer };
}

const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round(value(r) * 100)}%)` : ""}`;
const secs = (s) => (s.n === 0 ? "n/a" : `${(s.mean / 1000).toFixed(0)} s`);
const usd = (s) => (s.n === 0 ? "n/a" : `$${s.mean.toFixed(2)}`);
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

// Score format 2: every saved attempt as a sample. Kept for the comparison
// format 3 states, and for anyone reading a legacy run with today's code.
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

// Score format 3 of a loaded run: `score` is score.json, `outcomes` the lines
// of outcomes.jsonl, `jobs` the scored jobs (for a comparison).
export function scoreRun(run, { decisionsHash = null } = {}) {
  const m = run.manifest;
  const suite = m.suite ?? "planted";
  const origin = originOf(suite);
  if (origin === null) throw new Error(`the run names the suite ${suite}, which the scorer does not know`);
  const pop = population(m, run.attempts);
  if (pop.problems.length > 0) throw new Error(`the run's samples do not match its plan:\n${pop.problems.join("\n")}`);
  const jobs = pop.jobs.map((j) => scoreJob({ job: j, spec: run.specs[j.case], report: j.first?.report ?? null, brief: j.first?.brief ?? null, row: j.first?.row ?? {}, origin, started: j.first !== null }));
  const configs = [...new Set(jobs.map((j) => j.config))].sort();
  const byConfig = {};
  for (const config of configs) {
    const all = summarize(run.samples.filter((s) => s.config === config));
    byConfig[config] = {
      ...summarizeJobs(jobs.filter((j) => j.config === config), pop.retries.filter((a) => a.config === config).map((a) => a.sample)),
      allAttempts: { label: ALL_ATTEMPTS_LABEL, samples: all.samples, recall: all.recall, precision: all.precision },
    };
  }
  const perCase = {};
  const perBug = {};
  for (const j of jobs) {
    perCase[j.config] ??= {};
    const c = (perCase[j.config][j.caseId] ??= { issueRecall: ratio(), precision: { lower: ratio(), upper: ratio() }, findings: 0 });
    c.issueRecall = add(c.issueRecall, j.issueRecall.all);
    c.precision.lower = add(c.precision.lower, { hit: j.precision.correct, of: j.precision.of });
    c.precision.upper = add(c.precision.upper, { hit: j.precision.correct + j.precision.unresolved, of: j.precision.of });
    c.findings += j.precision.of;
    perBug[j.config] ??= {};
    const bugs = (perBug[j.config][j.caseId] ??= {});
    for (const b of j.bugs) {
      const x = (bugs[b.id] ??= { found: [], severity: b.severity, cause: null });
      x.found[j.repeat - 1] = b.found;
    }
  }
  const briefFailures = {};
  for (const config of configs) {
    const seen = new Map();
    for (const j of jobs.filter((x) => x.config === config)) for (const f of j.failures) seen.set(`${j.case}: ${f}`, (seen.get(`${j.case}: ${f}`) ?? 0) + 1);
    briefFailures[config] = [...seen].map(([what, n]) => ({ what, reviews: n }));
  }
  const outcomes = jobs.flatMap((j) =>
    j.findings.map((f) => ({
      jobId: j.jobId,
      caseId: j.caseId,
      config: j.config,
      repeat: j.repeat,
      index: f.index,
      findingId: f.findingId,
      issueId: null,
      outcome: f.outcome,
      truthId: f.bug ?? null,
      evidenceKind: f.evidenceKind,
      cause: null,
      confidence: f.confidence,
      severity: f.severity ?? null,
      severityAgreement: null,
      finder: null,
      wording: null,
    })),
  );
  const caseIds = [...new Set(jobs.map((j) => j.caseId))].sort();
  const score = {
    version: 3,
    rules: RULES,
    run: run.name,
    suite,
    split: m.split ?? "dev",
    splitHash: m.splitHash ?? null,
    mode: m.mode ?? "review",
    path: m.path ?? "laptop",
    build: m.build ?? null,
    reviewers: m.reviewers ?? (m.reviewer ? { [m.reviewer.name]: m.reviewer } : null),
    caseIds,
    caseSetHash: caseIds.every((id) => parseCaseId(id) !== null) ? caseSetHash(caseIds) : null,
    decisionsHash,
    external: m.external ?? null,
    repeat: m.repeat ?? null,
    population: { ...summarizeJobs(jobs, pop.retries.map((a) => a.sample)).population, jobsFrom: pop.from, unplanned: pop.unplanned.map((a) => `${a.case}/${a.config}/${a.repeat}`), unrecorded: run.unrecorded },
    ended: m.ended ?? null,
    resumes: run.resumes,
    specsFrom: run.specsFrom ?? "the run's own cases/",
    specsDiffer: run.specsDiffer,
    byConfig,
    perCase,
    perBug,
    briefFailures,
  };
  return { score, outcomes, jobs };
}

const bounds = (b) => (b.lower.of === 0 ? "n/a" : `${pct(b.lower)} to ${pct(b.upper)}`);

export function renderV3(s) {
  const configs = Object.keys(s.byConfig);
  const out = [];
  const p = s.population;
  out.push(`Run ${s.run}`);
  out.push(`Build ${s.build?.short ?? "unknown"} (openqodex ${s.build?.cliVersion ?? "unknown"}${s.build?.dirty ? ", built from a tree the commit does not hold" : ""}); suite ${s.suite}, split ${s.split}; scoring rules version ${s.rules.version} (${s.rules.hash.slice(0, 12)}).`);
  out.push(`Population: ${p.planned} planned reviews (${p.jobsFrom === "manifest" ? "from the manifest's jobs" : "derived from the manifest's cases, configurations and repeats, since it lists no jobs"}), each scored by its first attempt: ${p.complete} complete, ${p.incomplete} incomplete, ${p.failed} failed, ${p.unstarted} never started. ${p.retries} retries, scored apart${p.retries > 0 ? ` (cost ${p.retryCostUsd === null ? "unknown" : `$${p.retryCostUsd.toFixed(2)}`})` : ""}.`);
  if (p.unplanned.length > 0) out.push(`Left out: ${p.unplanned.length} first attempts of no planned review (${p.unplanned.join(", ")}).`);
  if (p.unrecorded > 0) out.push(`${p.unrecorded} attempts the runner never finished recording are scored from their folders.`);
  if (s.specsFrom !== "the run's own cases/") out.push(`Scored against the specs in ${s.specsFrom}, not the run's own; they differ for: ${s.specsDiffer.join(", ") || "no case"}.`);
  // The difference from score format 2, which counted every saved attempt.
  for (const c of configs) {
    const x = s.byConfig[c];
    const a = x.allAttempts;
    const legacy = x.plantedLegacy?.precision ?? null;
    const same = a.recall.hit === x.issueRecall.all.hit && a.recall.of === x.issueRecall.all.of && (legacy === null || (a.precision.hit === legacy.hit && a.precision.of === legacy.of));
    if (same && x.population.retries === 0 && x.population.unstarted === 0) continue;
    out.push(`${c}: counting every saved attempt, as score format 2 did, gives recall ${pct(a.recall)} and planted-rule precision ${pct(a.precision)} over ${a.samples} attempts; this score counts the first attempt of each of ${x.population.planned} planned reviews (${x.population.retries} retries left out, ${x.population.unstarted} never started), so recall is ${pct(x.issueRecall.all)}${legacy ? ` and planted-rule precision ${pct(legacy)}` : ""}.`);
  }
  out.push("");
  const loc = (c) => `precision ${pct(c.location.precision)}, recall ${pct(c.location.recall)}${c.location.knownNoise > 0 ? `, ${c.location.knownNoise} known noise` : ""}`;
  const rows = [
    ["Issue recall, all", (c) => pct(c.issueRecall.all)],
    ["Issue recall, critical and major", (c) => pct(c.issueRecall.criticalMajor)],
    ["Precision, lower to upper bound", (c) => bounds(c.precision)],
    ["Unresolved findings (no ruling yet)", (c) => String(c.precision.unresolved)],
    ["Unique-issue precision, lower to upper", (c) => bounds(c.uniqueIssuePrecision)],
    ["Redundancy (findings beyond one per issue)", (c) => pct(c.redundancy)],
    ["F1 (on the lower precision bound)", (c) => c.f1.toFixed(2)],
    ["Clean changes with no finding", (c) => pct(c.controls)],
    ["Findings per clean change", (c) => (c.cleanFindingsPerCase.cases === 0 ? "n/a" : (c.cleanFindingsPerCase.findings / c.cleanFindingsPerCase.cases).toFixed(2))],
    ["Reviews complete / incomplete / failed / never started", (c) => `${c.population.complete} / ${c.population.incomplete} / ${c.population.failed} / ${c.population.unstarted}`],
    ["Planted-rule precision (format 2 rule, planted only)", (c) => (c.plantedLegacy ? pct(c.plantedLegacy.precision) : "n/a")],
    ["Location diagnostic (line rule, K=1)", loc],
    ["Graph gaps disclosed in the brief", (c) => pct(c.brief.gaps)],
    ["Callers listed in the brief", (c) => pct(c.brief.callers)],
    ["Time per review, mean (median)", (c) => (c.wallMs.n === 0 ? "n/a" : `${secs(c.wallMs)} (${(c.wallMs.median / 1000).toFixed(0)} s)`)],
    ["Cost per review, mean", (c) => usd(c.costUsd)],
    ["Cost, total (retries apart)", (c) => (c.costUsd.n === 0 ? "n/a" : `$${c.costUsd.total.toFixed(2)}`)],
    ["Tokens in / out per review, mean", (c) => (c.inputTokens.n === 0 ? "n/a" : `${Math.round(c.inputTokens.mean / 1000)}k / ${Math.round(c.outputTokens.mean / 1000)}k`)],
  ];
  out.push(table(["Measure", ...configs], rows.map(([label, f]) => [label, ...configs.map((c) => f(s.byConfig[c]))])));
  out.push("");
  out.push("Per case (issue recall; precision bounds):");
  out.push("");
  const caseIds = [...new Set(configs.flatMap((c) => Object.keys(s.perCase[c] ?? {})))].sort();
  out.push(table(["Case", ...configs], caseIds.map((id) => [id, ...configs.map((c) => {
    const x = s.perCase[c]?.[id];
    return x ? `${pct(x.issueRecall)}; ${bounds(x.precision)}` : "n/a";
  })])));
  out.push("");
  const missed = configs.flatMap((c) => Object.entries(s.perBug[c] ?? {}).flatMap(([id, bugs]) => Object.entries(bugs).filter(([, b]) => b.found.some((f) => !f)).map(([bug, b]) => [c, id, bug, b.severity, `${b.found.filter(Boolean).length}/${b.found.length}`])));
  if (missed.length > 0) {
    out.push("Truth items not found in every planned review:");
    out.push("");
    out.push(table(["Configuration", "Case", "Bug", "Severity", "Found"], missed));
    out.push("");
  }
  for (const c of configs) {
    if ((s.briefFailures[c] ?? []).length === 0) continue;
    out.push(`What the brief did not say (${c}):`);
    for (const f of s.briefFailures[c]) out.push(`- ${f.what} (${f.reviews} reviews)`);
    out.push("");
  }
  return out.join("\n");
}

// Everything besides the build that differs between two runs.
export function differences(older, newer) {
  return [...runDifferences(older.manifest, newer.manifest), ...specDifferences(older.specs, newer.specs)];
}

export function renderCompare(older, newer, so, sn, regs) {
  const out = [];
  const diffs = differences(older, newer);
  out.push(`Comparing ${older.name} (build ${older.manifest.build?.short}) with ${newer.name} (build ${newer.manifest.build?.short}), both scored with these rules.`);
  if (diffs.length > 0) {
    out.push("These differ besides the build, so a change below may not be the product's:");
    for (const d of diffs) out.push(`- ${d}`);
  }
  out.push("");
  const configs = [...new Set([...Object.keys(so.byConfig), ...Object.keys(sn.byConfig)])].sort();
  const cell = (s, cfg, f) => (s.byConfig[cfg] ? f(s.byConfig[cfg]) : "n/a");
  const rows = [];
  for (const cfg of configs) {
    rows.push([cfg, "issue recall", cell(so, cfg, (c) => pct(c.issueRecall.all)), cell(sn, cfg, (c) => pct(c.issueRecall.all))]);
    rows.push([cfg, "precision bounds", cell(so, cfg, (c) => bounds(c.precision)), cell(sn, cfg, (c) => bounds(c.precision))]);
    rows.push([cfg, "clean controls", cell(so, cfg, (c) => pct(c.controls)), cell(sn, cfg, (c) => pct(c.controls))]);
    rows.push([cfg, "never started or failed", cell(so, cfg, (c) => String(c.population.unstarted + c.population.failed)), cell(sn, cfg, (c) => String(c.population.unstarted + c.population.failed))]);
    rows.push([cfg, "graph gaps", cell(so, cfg, (c) => pct(c.brief.gaps)), cell(sn, cfg, (c) => pct(c.brief.gaps))]);
    rows.push([cfg, "time per review", cell(so, cfg, (c) => secs(c.wallMs)), cell(sn, cfg, (c) => secs(c.wallMs))]);
    rows.push([cfg, "cost per review", cell(so, cfg, (c) => usd(c.costUsd)), cell(sn, cfg, (c) => usd(c.costUsd))]);
  }
  out.push(table(["Configuration", "Measure", `Before (${older.manifest.build?.short})`, `After (${newer.manifest.build?.short})`], rows));
  out.push("");
  if (regs.length === 0) out.push("No regression: no truth item is missed in two or more reviews more often than before.");
  else {
    out.push("Regressions (missed in two or more reviews, more often than before):");
    for (const r of regs) out.push(`- ${r.config} ${r.case} ${r.bug}: found ${r.before} before, ${r.after} after`);
  }
  return out.join("\n");
}

// The adjudication file's hash, or null while there is none (P1-T8 adds it).
function decisionsHash() {
  const path = join(benchRoot, "review-queue", "decisions.jsonl");
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function main() {
  const args = process.argv.slice(2);
  let against = null;
  let specsDir = null;
  let outDir = null;
  let json = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--against") against = args[++i];
    else if (args[i] === "--json") json = true;
    else if (args[i] === "--specs") specsDir = args[++i];
    else if (args[i] === "--out") outDir = args[++i];
    else pos.push(args[i]);
  }
  if (pos.length !== 1 || against === undefined || specsDir === undefined || outDir === undefined) {
    console.error("usage: node benchmark/score.mjs <results folder> [--against <earlier results folder>] [--specs <folder of <case>.json>] [--out <folder>] [--json]");
    process.exit(2);
  }
  let run;
  let older = null;
  let scored;
  let olderScored = null;
  try {
    run = loadRun(resolve(pos[0]), { specsDir: specsDir === null ? null : resolve(specsDir) });
    if (outDir === null && readRecipes().runs[basename(run.folder)]) {
      throw new Error(`${run.name} is a legacy run: its folder is the published original and holds the score its own scorer wrote. Write its format 3 score elsewhere with --out <folder>.`);
    }
    if (against) older = loadRun(resolve(against));
    const hash = decisionsHash();
    scored = scoreRun(run, { decisionsHash: hash });
    if (older) olderScored = scoreRun(older, { decisionsHash: hash });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { score, outcomes, jobs } = scored;
  const regs = older ? regressions(olderScored.jobs, jobs) : [];
  const doc = { ...score, comparedWith: older ? { run: older.name, build: older.manifest.build, differences: differences(older, run), regressions: regs } : null };
  // Scored against other specs, the score gets its own files, so the score
  // against the run's own specs is never overwritten.
  const suffix = specsDir === null ? "" : `-${basename(resolve(specsDir))}`;
  const dest = outDir === null ? run.folder : resolve(outDir);
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, `score${suffix}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(join(dest, `outcomes${suffix}.jsonl`), outcomes.map((o) => `${JSON.stringify(o)}\n`).join(""));
  if (json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(renderV3(score));
    if (older) console.log(`\n${renderCompare(older, run, olderScored.score, score, regs)}`);
    const shown = (p) => (relative(repoRoot, p).startsWith("..") ? p : relative(repoRoot, p));
    console.log(`\nScore saved: ${shown(join(dest, `score${suffix}.json`))}, with ${outcomes.length} finding outcomes in ${shown(join(dest, `outcomes${suffix}.jsonl`))}`);
  }
  process.exit(regs.length > 0 ? 1 : 0);
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
