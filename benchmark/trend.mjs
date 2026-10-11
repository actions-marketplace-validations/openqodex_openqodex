#!/usr/bin/env node
// The trend over the committed index, its regression alarm, and the accept
// step:
//
//   node benchmark/trend.mjs [--suite <suite>] [--mode review|scan] [--config <config>] [--alpha 0.05] [--index <folder>]
//   node benchmark/trend.mjs --accept <run-id> --by <name> [--index <folder>] [--results <folder>]
//
// The trend reads every entry under benchmark/index/runs (or <folder>/runs)
// and the accepted pointer benchmark/index/accepted.json, groups the runs by
// suite, split, split hash, mode, path, reviewer, model, configuration and
// rules version (lib/index.mjs groupKeys), and prints each group's runs by
// start time with their issue-level numbers and intervals. Legacy runs are
// listed with their own scorer's numbers and no interval. In every group
// with an accepted run, the newest run is compared with it on the cases
// both hold, and the alarm is raised when:
// - an issue-level ratio (issue recall, critical and major issue recall,
//   and each precision bound against the same bound) drops outside the
//   noise: the paired sign-flip test over clusters (lib/interval.mjs
//   pairedBounds) puts the change's one-sided upper bound below zero at
//   the alarm's alpha split equally across those four ratios, and the drop
//   is at least MIN_DROP; or
// - a hard rule breaks: a critical issue found in two or more reviews of
//   the accepted run is found in at most one now (with at least two
//   reviews), or a clean change fails its control in two or more reviews
//   where it failed in at most one before.
// Location metrics are printed as diagnostics and never raise the alarm.
//
// --accept first checks the entry against its run: the run folder
// <results>/<run-id> (benchmark/results unless --results names another)
// must be the folder the run was published from or a copy fetched from its
// asset, and the entry built again from it must equal the committed one.
// Then it marks the entry accepted and points every group the run holds at
// it in accepted.json, with the run id, its build commit and the entry's
// score hash (lib/index.mjs scoreHash); the top level names the run
// accepted last, whose commit is the reviewer loop's base. Commit both
// files in the pull request that carries the decision.
//
// Exit codes: 0 no regression (or accepted); 1 a regression against an
// accepted run; 2 refused or failed (an unsound entry or pointer, an
// accepted entry edited after it was accepted, two runs of one group under
// different rules, a run that cannot be accepted).
//
// Failure list, written before the code:
// 1. A drop inside the noise fails the trend: a ratio's drop counts only
//    when the paired sign-flip test over clusters (cases, or repository
//    groups on real suites, with every repeat kept in its cluster) rejects
//    no change at the split alpha, and it is at least MIN_DROP. A bootstrap
//    is not used here: it calls a drop carried by a few cases significant
//    at any number of cases (lib/interval.mjs says why).
// 2. A real drop passes it: every issue-level ratio is compared, and each
//    precision bound against the same bound of the accepted run, so a drop
//    in confirmed findings raises the alarm though unresolved ones hide it
//    in the upper bound. (Comparing the candidate's lower bound with the
//    accepted run's upper bound, as an acceptance decision does, would
//    raise the alarm on unresolved findings alone.)
// 3. A critical issue lost in two reviews, or a clean change that starts
//    drawing findings, passes because it is small next to the whole run:
//    the hard rules apply whatever the interval reads.
// 4. The trend compares against numbers nobody accepted: the pointer's
//    score hash must match the accepted entry, or the trend stops.
// 5. Runs scored under different rules, by different models or on another
//    split are compared: they are in different groups, and one group under
//    two rules hashes stops the trend.
// 6. A run that cannot be a baseline is accepted: a legacy run, a run
//    already accepted, a draft, a dirty build, a run that did not finish or
//    has planned reviews that never started, and a run that does not
//    record every scanner installed are refused.
// 7. A rerun of the trend draws other numbers: every sampled test is
//    seeded from the two run ids, the configuration and the metric.
// 8. An entry edited before it is accepted, so its numbers no longer match
//    the run's published score, is accepted all the same: --accept hashes
//    the run folder and checks it against the entry's list hashes, builds
//    the entry again from the folder's manifest, resumes and score.json
//    the way publish-run.mjs does, and refuses on any difference, before
//    it writes either file.
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/cases.mjs";
import { ACCEPTED_VERSION, acceptedPath, acceptedProblems, buildEntry, entryProblems, groupKeys, hashFolder, indexRoot, listEntries, resultsRoot, scoreHash, writeEntry } from "./lib/index.mjs";
import { ISSUE_METRICS, RESAMPLES, clusterFn, pairedBounds, pairedSums, seedOf } from "./lib/interval.mjs";
import { canonical, rulesDifferences } from "./lib/score.mjs";

// The alarm's one-sided error over the four issue-level ratios, split
// equally across them, and the smallest drop it names (3 points).
export const ALPHA = 0.05;
export const MIN_DROP = 0.03;

const ratioOf = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const sumSide = (pairs, side) => pairs.reduce((t, p) => ({ hit: t.hit + p[side].hit, of: t.of + p[side].of }), { hit: 0, of: 0 });

// The hard rules (failure 3), from each run's per-bug results and per-case
// clean controls, on the cases both hold. One line per broken rule.
export function hardRules(accepted, candidate, config) {
  const out = [];
  const bugsBefore = accepted.perBug?.[config] ?? {};
  const bugsNow = candidate.perBug?.[config] ?? {};
  for (const id of Object.keys(bugsBefore).sort()) {
    for (const bug of Object.keys(bugsBefore[id]).sort()) {
      const b = bugsBefore[id][bug];
      const a = bugsNow[id]?.[bug];
      if (!a || b.severity !== "critical") continue;
      const before = b.found.filter((f) => f === true).length;
      const now = a.found.filter((f) => f === true).length;
      if (before >= 2 && a.found.length >= 2 && now <= 1) out.push(`${id} ${bug} (critical): found in ${before} of ${b.found.length} reviews of the accepted run, in ${now} of ${a.found.length} now`);
    }
  }
  const casesBefore = accepted.perCase?.[config] ?? {};
  const casesNow = candidate.perCase?.[config] ?? {};
  for (const id of Object.keys(casesBefore).sort()) {
    const b = casesBefore[id].controls;
    const a = casesNow[id]?.controls;
    if (!a || b.of === 0 || a.of === 0) continue;
    const before = b.of - b.hit;
    const now = a.of - a.hit;
    if (now >= 2 && before <= 1) out.push(`${id}: a clean change fails its control (a finding, or no complete review) in ${now} of ${a.of} reviews now, in ${before} of ${b.of} before`);
  }
  return out;
}

// One configuration of a candidate run against the accepted run of its
// group: each issue-level ratio's paired change with its one-sided upper
// bound, the hard rules, and whether the alarm is raised. Each run is an
// index entry, or anything with its runId, perCase, perBug and intervals.
export function compareConfig(accepted, candidate, config, { alpha = ALPHA, resamples = RESAMPLES, minDrop = MIN_DROP } = {}) {
  const groups = candidate.intervals?.groups ?? accepted.intervals?.groups ?? null;
  const clusterOf = clusterFn(groups);
  const before = accepted.perCase?.[config] ?? {};
  const now = candidate.perCase?.[config] ?? {};
  const shared = Object.keys(before).filter((id) => now[id] !== undefined).sort();
  const share = alpha / ISSUE_METRICS.length;
  const metrics = ISSUE_METRICS.map((m) => {
    const pick = (cases) => Object.fromEntries(shared.map((id) => [id, m.perCase(cases[id])]));
    const pairs = pairedSums(pick(before), pick(now), clusterOf);
    const r = pairedBounds({ pairs, seed: seedOf("trend", accepted.runId, candidate.runId, config, m.name), alpha: share, resamples });
    const alarm = r.upper < 0 && r.delta <= -minDrop;
    return { name: m.name, label: m.label, before: ratioOf(sumSide(pairs, "a")), after: ratioOf(sumSide(pairs, "b")), delta: r.delta, upper: r.upper, pLower: r.pLower, method: r.method, changed: r.changed, clusters: r.clusters, alarm };
  });
  const hard = hardRules(accepted, candidate, config);
  return { config, shared: shared.length, unit: groups === null ? "cases" : "repository groups", alpha: share, metrics, hard, regressed: hard.length > 0 || metrics.some((m) => m.alarm) };
}

const pct1 = (x) => `${(x * 100).toFixed(1)}%`;
const points = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} points`;
const pct = (r) => `${r.hit}/${r.of}${r.of > 0 ? ` (${Math.round((r.hit / r.of) * 100)}%)` : ""}`;
const withCi = (r) => `${pct(r)}${Array.isArray(r.ci) ? ` [${Math.round(r.ci[0] * 100)}%, ${Math.round(r.ci[1] * 100)}%]` : ""}`;
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const startOf = (e) => e.startedAt ?? e.date;
const byStart = (a, b) => (startOf(a) < startOf(b) ? -1 : startOf(a) > startOf(b) ? 1 : a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

function verdict(m) {
  if (m.alarm) return "outside the noise";
  if (m.upper < 0) return `a drop smaller than ${Math.round(MIN_DROP * 100)} points`;
  return "inside the noise";
}

function groupLabel(e, g) {
  const rules = e.rulesVersion === null || e.rulesVersion === undefined ? "legacy rules (each run scored by its own scorer)" : `rules version ${e.rulesVersion}`;
  return `${e.suite}, ${e.split} split${e.splitHash ? ` ${e.splitHash.slice(0, 8)}` : ""}, ${e.mode}, ${e.path} path, ${g.reviewer} (${g.model}), ${g.config}, ${rules}`;
}

function row(e, config, current) {
  const s = e.scores[config];
  const cost = typeof s.costUsdMean === "number" ? `$${s.costUsdMean.toFixed(2)}` : "n/a";
  const time = typeof s.wallMsMean === "number" ? `${Math.round(s.wallMsMean / 1000)} s` : "n/a";
  const build = `${e.build.short} (${e.build.cliVersion ?? "unknown"})`;
  if (e.legacy) return [startOf(e), e.runId, build, pct(s.recall), "n/a", `${pct(s.precision)}, one value by its scorer's rule`, pct(s.controls), "n/a", cost, time, "legacy: its own scorer, no interval"];
  const status = [current ? "accepted" : e.accepted ? "accepted before" : null, e.draft ? "draft" : null, e.release ? `release ${e.release}` : null].filter(Boolean).join(", ");
  const loc = `precision ${pct(s.location.precision)}, recall ${pct(s.location.recall)}`;
  return [startOf(e), e.runId, build, withCi(s.issueRecall.all), withCi(s.issueRecall.criticalMajor), `${withCi(s.precision.lower)} to ${withCi(s.precision.upper)}`, pct(s.controls), loc, cost, time, status];
}

class Refusal extends Error {}

// The index under `index`: every entry, checked, and the accepted pointer,
// checked against them (null when no run is accepted yet).
function readIndex(index) {
  const entries = listEntries(join(index, "runs")).map(({ entry }) => entry);
  const problems = entries.flatMap((e) => entryProblems(e));
  if (problems.length > 0) throw new Refusal(`the index holds unsound entries:\n${problems.join("\n")}`);
  const byId = new Map(entries.map((e) => [e.runId, e]));
  const path = acceptedPath(index);
  if (!existsSync(path)) return { entries, byId, pointer: null };
  let pointer;
  try {
    pointer = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Refusal(`${path} is not JSON: ${error.message}`);
  }
  const wrong = acceptedProblems(pointer, byId);
  if (wrong.length > 0) throw new Refusal(wrong.join("\n"));
  return { entries, byId, pointer };
}

// Prints the trend and returns whether any group regressed.
export function runTrend({ index = indexRoot, suite = null, mode = null, config = null, alpha = ALPHA, log = console.log } = {}) {
  const { entries, byId, pointer } = readIndex(index);
  const groups = new Map();
  for (const e of entries) {
    if ((suite && e.suite !== suite) || (mode && e.mode !== mode)) continue;
    for (const g of groupKeys(e)) {
      if (config && g.config !== config) continue;
      if (!groups.has(g.key)) groups.set(g.key, { label: groupLabel(e, g), config: g.config, entries: [] });
      groups.get(g.key).entries.push(e);
    }
  }
  const shown = relative(repoRoot, index).startsWith("..") ? index : relative(repoRoot, index) || ".";
  log(`Trend over ${entries.length} runs in ${shown}, in ${groups.size} ${groups.size === 1 ? "group" : "groups"}${suite || mode || config ? " (filtered)" : ""}.`);
  if (pointer === null) log("No run is accepted yet, so nothing is compared and no alarm can be raised.");
  const regressed = [];
  for (const key of [...groups.keys()].sort()) {
    const g = groups.get(key);
    const runs = [...g.entries].sort(byStart);
    const acceptedId = pointer?.groups?.[key]?.runId ?? null;
    log("");
    log(g.label);
    log("");
    log(table(["Started", "Run", "Build", "Issue recall", "Critical and major recall", "Precision, lower to upper", "Clean controls", "Location (diagnostic)", "Cost per review", "Time per review", "Status"], runs.map((e) => row(e, g.config, e.runId === acceptedId))));
    if (acceptedId === null) continue;
    const accepted = byId.get(acceptedId);
    const newest = runs[runs.length - 1];
    log("");
    if (newest.runId === acceptedId) {
      log(`The accepted run ${acceptedId} is the newest of this group.`);
      continue;
    }
    if (newest.perCase === null || accepted.perCase === null) {
      log(`Held-out entries hold aggregates only, so ${newest.runId} is not paired with ${acceptedId}.`);
      continue;
    }
    const rules = rulesDifferences({ version: accepted.rulesVersion, hash: accepted.rulesHash }, { version: newest.rulesVersion, hash: newest.rulesHash });
    if (rules.length > 0) throw new Refusal(`${newest.runId} cannot be compared with the accepted run ${acceptedId}: ${rules.join("; ")}`);
    const c = compareConfig(accepted, newest, g.config, { alpha });
    log(`The newest run ${newest.runId} against the accepted run ${acceptedId}, on ${c.shared} shared cases (paired sign-flip test over ${c.unit}, one-sided, alpha ${c.alpha} per ratio):`);
    for (const m of c.metrics) {
      const how = `${m.method}, ${m.changed} changed ${m.changed === 1 ? c.unit.replace(/s$/, "") : c.unit}`;
      log(`- ${m.label}: ${pct1(m.after)} against ${pct1(m.before)}, a change of ${points(m.delta)}; upper bound ${points(m.upper)}, one-sided p ${(m.pLower * 100).toFixed(2)}% (${how}): ${verdict(m)}`);
    }
    if (c.hard.length > 0) {
      log("Hard rules broken:");
      for (const h of c.hard) log(`- ${h}`);
    }
    const la = accepted.scores[g.config].location;
    const ln = newest.scores[g.config].location;
    log(`Location, a diagnostic only: precision ${pct(ln.precision)} against ${pct(la.precision)}, recall ${pct(ln.recall)} against ${pct(la.recall)}.`);
    if (c.regressed) regressed.push(`${g.label}: ${newest.runId} against ${acceptedId}`);
  }
  log("");
  if (regressed.length === 0) log(pointer === null ? "No alarm." : "No regression against the accepted runs.");
  else {
    log("Regression against the accepted run:");
    for (const r of regressed) log(`- ${r}`);
  }
  return regressed.length > 0;
}

// Why an entry cannot be a baseline (failure 6); empty when it can.
export function acceptRefusals(e) {
  const out = [];
  if (e.legacy) out.push("it is a legacy run, scored by its own scorer before score format 3; legacy runs are listed, never accepted");
  if (e.accepted) out.push(`it is already accepted (${e.acceptedAt} by ${e.acceptedBy})`);
  if (e.draft === true) out.push("it is a draft run, whose cases need not match the lock");
  if (e.build?.dirty !== false) out.push("its build is dirty: the commit does not hold the tree the reviewed CLI was built from");
  if (e.ended?.how !== "finished") out.push(`it ended as "${e.ended?.how ?? "unknown"}"${e.ended?.why ? ` (${e.ended.why})` : ""}, not finished`);
  // Unknown counts as missing: a run made before run.mjs records its scanner
  // preflight (P1-T13) may have lacked Ruby or Go scanners, so no such run
  // becomes a baseline.
  if (e.scannersComplete !== true) out.push("it does not record every scanner its cases need as installed (scannersComplete is not true)");
  for (const [config, s] of Object.entries(e.scores ?? {})) if ((s.population?.unstarted ?? 0) > 0) out.push(`${config}: ${s.population.unstarted} planned reviews never started`);
  return out;
}

// Why a committed entry is not the one its run gives (failure 8); empty
// when it is. The folder <results>/<run-id> must be the one the run was
// published from (its file list hash is the entry's privateListHash) or a
// copy fetched from the asset (its list hash is the asset's), and the entry
// built from its files the way publish-run.mjs builds it must equal the
// committed one, the accepted mark aside.
export function runMismatch(entry, results) {
  const folder = join(results, entry.runId);
  if (!existsSync(join(folder, "manifest.json"))) return [`the run folder ${folder} is missing: fetch it with node benchmark/fetch-run.mjs ${entry.runId}, or name the folder that holds it with --results`];
  const { listHash: hash } = hashFolder(folder);
  if (hash !== entry.privateListHash && hash !== entry.asset.listHash) return [`${folder} is neither the published asset nor the folder it was published from (its file list hash is ${hash}): fetch the run again into an empty folder`];
  let rebuilt;
  try {
    const read = (file) => JSON.parse(readFileSync(join(folder, file), "utf8"));
    const resumes = existsSync(join(folder, "resumes.jsonl")) ? readFileSync(join(folder, "resumes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    rebuilt = buildEntry({ runId: entry.runId, manifest: read("manifest.json"), resumes, score: read("score.json"), asset: entry.asset, privateListHash: entry.privateListHash });
  } catch (error) {
    return [`the entry cannot be built again from ${folder}: ${error.message}`];
  }
  const committed = { ...entry, accepted: false, acceptedAt: null, acceptedBy: null };
  const differ = [...new Set([...Object.keys(rebuilt), ...Object.keys(committed)])].filter((k) => canonical(rebuilt[k] ?? null) !== canonical(committed[k] ?? null)).sort();
  const out = entryProblems(rebuilt);
  if (differ.length > 0) out.push(`the entry does not match its run: ${differ.join(", ")} differ from what ${folder} gives`);
  return out;
}

// Marks one run accepted and points every group it holds at it.
export function acceptRun({ index = indexRoot, results = resultsRoot, runId, by, now = new Date().toISOString(), log = console.log }) {
  if (typeof by !== "string" || by.trim() === "") throw new Refusal("--accept needs --by <name>: who accepts the run");
  const { byId, pointer } = readIndex(index);
  const entry = byId.get(runId);
  if (!entry) throw new Refusal(`refused: the index holds no entry ${runId}`);
  const why = acceptRefusals(entry);
  if (why.length === 0) why.push(...runMismatch(entry, results));
  if (why.length > 0) throw new Refusal(`refused: ${runId} cannot be accepted:\n${why.map((w) => `- ${w}`).join("\n")}`);
  const marked = { ...entry, accepted: true, acceptedAt: now, acceptedBy: by };
  const written = writeEntry(marked, join(index, "runs"));
  const record = { runId, commit: entry.build.commit, scoreHash: scoreHash(marked), acceptedAt: now, acceptedBy: by };
  const groups = { ...pointer?.groups };
  const keys = groupKeys(marked).map((g) => g.key);
  for (const key of keys) groups[key] = record;
  const next = { version: ACCEPTED_VERSION, ...record, groups: Object.fromEntries(Object.keys(groups).sort().map((k) => [k, groups[k]])) };
  writeFileSync(acceptedPath(index), `${JSON.stringify(next, null, 2)}\n`);
  log(`Accepted ${runId} (commit ${entry.build.commit}) by ${by} for ${keys.length} ${keys.length === 1 ? "group" : "groups"}:`);
  for (const key of keys) log(`- ${key}`);
  log(`Commit ${acceptedPath(index)} and ${written} in the pull request that carries the decision.`);
}

function main() {
  const args = process.argv.slice(2);
  const o = { index: indexRoot, results: resultsRoot, suite: null, mode: null, config: null, alpha: ALPHA, accept: null, by: null };
  const value = (i) => {
    if (i + 1 >= args.length) throw new Refusal(`${args[i]} needs a value`);
    return args[i + 1];
  };
  try {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--index") o.index = resolve(value(i++));
      else if (a === "--suite") o.suite = value(i++);
      else if (a === "--mode") o.mode = value(i++);
      else if (a === "--config") o.config = value(i++);
      else if (a === "--accept") o.accept = value(i++);
      else if (a === "--by") o.by = value(i++);
      else if (a === "--results") o.results = resolve(value(i++));
      else if (a === "--alpha") {
        o.alpha = Number(value(i++));
        if (!(o.alpha > 0 && o.alpha < 1)) throw new Refusal("--alpha must be a number between 0 and 1");
      } else throw new Refusal(`unknown argument ${a}\nusage: node benchmark/trend.mjs [--suite <suite>] [--mode review|scan] [--config <config>] [--alpha 0.05] [--index <folder>]\n       node benchmark/trend.mjs --accept <run-id> --by <name> [--index <folder>] [--results <folder>]`);
    }
    if (o.accept !== null) {
      acceptRun({ index: o.index, results: o.results, runId: o.accept, by: o.by });
      process.exit(0);
    }
    process.exit(runTrend(o) ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Refusal ? error.message : error.stack);
    process.exit(2);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
