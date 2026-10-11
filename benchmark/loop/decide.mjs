#!/usr/bin/env node
// The acceptance rule of both loops (PLAN-benchmark 4.11), run by script:
// it reads a change's record from the reviewer ledger, compares the
// candidate's runs with the parent's (compare.mjs), and appends one line
// with the decision, its look number and its alpha.
//
//   node benchmark/loop/decide.mjs --change <RC-id> --pair <parent>=<candidate> [--pair ...]
//        [--stage 1|2|3] [--final] [--aa <run a>=<run b>]... [--ledger <file>]
//        [--decisions <file>] [--specs <folder>] [--pr <n>] [--json]
//   node benchmark/loop/decide.mjs --record <record.json> --pair ... [--look <t>] --dry-run
//
// A side is <run>[#<config>][@<repeats>]: a run folder or a run id under
// benchmark/results, optionally one configuration and some repeats; a pair
// without a configuration pairs every configuration both runs hold. Every
// path and reviewer the change runs on is one pair or more (one per suite).
// --aa names A/A pairs (two runs of the parent build) whose half-widths set
// the sample size; they never change a loss. --dry-run decides a record
// that is not in the ledger and writes nothing.
//
// The rule:
// - Look t is the t-th decision look in the ledger: every line with a look
//   number counts, every stage of every change. Its error budget is
//   alpha_t = 0.05 / (t (t + 1)), so all looks together spend at most 0.05,
//   split equally across the primary metric and its guards (one share per
//   gate metric of compare.mjs). Every bound is one-sided at that share.
// - The primary must be better on the target path, every reviewer there,
//   pooled over the suites: its decision reading (the bound worse for the
//   change) past zero in the better direction.
// - Every other metric, and the primary everywhere else (every path the
//   change runs on, every reviewer, the planted, real and pooled strata), is
//   a guard: its bound in the worse direction must stay inside the
//   acceptable loss the record declared before any run. A guard no review
//   measures (no clean case, no cost on either side) is named and does not
//   decide.
// - The hard rules (compare.mjs hardRules) refuse whatever the bounds read.
// - Three repeats on every pair, every path the record names, and on the
//   laptop path both Claude Code and Codex.
// - A bound wider than its loss is inconclusive, and inconclusive reverts.
//   A change is reverted outright when a guard is past its loss on both
//   like for like readings, the primary is worse on both, or a hard rule
//   breaks on the frozen numbers.
// - Stage 1 (one repeat) may only stop a change, never accept it. At stage
//   2, a change whose only open question is the primary may go to stage 3
//   (repeats 4 to 6, P3 part 4.4) unless --final; stage 3 is final.
// - An A/A pair's half-width past a loss marks the comparison inconclusive
//   (more cases or repeats are needed); it never widens the loss.
// - A record whose aim is "measure" is never accepted: it is "measured".
// - No live decision runs until the ledger holds a passing validation
//   (validate.mjs) of this rule as it stands: the rule's files are hashed
//   (ruleHash) and the validation line names the hash.
//
// Exit codes: 0 the line is written (or, with --dry-run, printed); 2
// refused (no record, no passing validation, runs that cannot be paired, a
// candidate built from another commit) or failed.
//
// Failure list, written before the code:
// 1. A later look uses the same bound as the first: the look number is
//    counted from the ledger under its lock, and alpha_t falls with it.
// 2. A guard failing on the other path lets the change through: every
//    path and reviewer is a cell, and every cell's guards decide.
// 3. A noisy A/A pair widens the permitted loss: losses come only from the
//    record; an A/A half-width past a loss makes the comparison
//    inconclusive.
// 4. A bootstrap treating repeats as independent cases accepts a null
//    change: the comparison swaps whole clusters (compare.mjs).
// 5. Unresolved findings decide a change: the decision reading is the bound
//    worse for the change, and a hard rule broken only through an
//    unresolved match leaves the change open, never accepted.
// 6. A change is accepted on one repeat, on one laptop reviewer, or with a
//    path it touches never run: each is a requirement of acceptance.
// 7. A decision is taken by a rule nobody validated, or one changed since:
//    the validation line must pass and name this rule's hash.
// 8. Two decisions take the same look number: the ledger is read and
//    appended under propose.mjs's lock.
// 9. A decision is made twice for one change, or for runs of another
//    commit: a decided change is refused, and the candidate's build commit
//    must be the record's.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionsPath } from "../score.mjs";
import { GATE_METRICS, comparePairs, loadSides, lossIn, metricOf, pairsOf, readRulings } from "./compare.mjs";
import { ToolError } from "./leak-check.mjs";
import { LEDGER, lockLedger, readLedger } from "./propose.mjs";

export const LOOP_ALPHA = 0.05;
export const alphaAt = (t) => LOOP_ALPHA / (t * (t + 1));
// The repeats acceptance needs on every pair, and the reviewers it needs
// on a path (PLAN question 19: Codex in every decision).
export const MIN_REPEATS = 3;
export const REQUIRED_REVIEWERS = { laptop: ["claude", "codex"] };
// A validation counts only with this many simulated look sequences.
export const MIN_SEQUENCES = 1000;
const EPS = 1e-12;

// The rule's own files: a change to any of them needs a new validation.
const RULE_FILES = ["./compare.mjs", "./decide.mjs", "../lib/interval.mjs"];
export function ruleHash() {
  const h = createHash("sha256");
  for (const f of RULE_FILES) h.update(`${f}\0${readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8")}\0`);
  return h.digest("hex");
}

export class Refusal extends Error {}

// The look number the next decision takes: one past the looks the ledger
// holds, which must run 1, 2, 3 in order.
export function lookOf(lines) {
  const looks = lines.filter((l) => l.look !== null && l.look !== undefined);
  looks.forEach((l, i) => {
    if (l.look !== i + 1) throw new Refusal(`the ledger's looks do not run 1, 2, 3 in order: line ${l.id} holds look ${JSON.stringify(l.look)} where ${i + 1} was due`);
  });
  return looks.length + 1;
}

// Why the ledger does not let a live decision run (failure 7).
export function validationProblems(lines, hash = ruleHash()) {
  const v = lines.filter((l) => l.event === "validation").at(-1);
  if (!v) return ["the ledger holds no validation line: run node benchmark/loop/validate.mjs on saved data first (PLAN 4.11)"];
  const out = [];
  if (v.ruleHash !== hash) out.push(`the last validation (${v.id}) is of another rule (hash ${String(v.ruleHash).slice(0, 12)}, the rule now ${hash.slice(0, 12)}); run validate.mjs again`);
  if (v.pass !== true) out.push(`the last validation (${v.id}) did not pass: ${v.reason}`);
  if (!(v.simulation?.sequences >= MIN_SEQUENCES)) out.push(`the last validation (${v.id}) simulated ${v.simulation?.sequences ?? 0} look sequences, fewer than ${MIN_SEQUENCES}`);
  return out;
}

// What is wrong with a record for a decision.
function recordProblems(record) {
  const out = [];
  const losses = record?.acceptableLoss ?? {};
  for (const m of GATE_METRICS) if (!Number.isFinite(losses[m]) || losses[m] < 0) out.push(`the record has no acceptable loss for ${m}`);
  for (const m of Object.keys(losses)) if (!GATE_METRICS.includes(m)) out.push(`the record's loss for ${m} is not one of the rule's metrics (${GATE_METRICS.join(", ")})`);
  if (!GATE_METRICS.includes(record?.primary?.metric)) out.push(`the primary metric ${record?.primary?.metric} is not one of ${GATE_METRICS.join(", ")}`);
  if (!Array.isArray(record?.paths) || record.paths.length === 0) out.push("the record names no path");
  if (!record?.paths?.includes(record?.target)) out.push(`the target ${record?.target} is not one of the record's paths`);
  return out;
}

const higher = (metric) => metricOf(metric).better === "higher";
const likeReadings = (r) => (r.like ? [r.like.lower, r.like.upper] : [r]);

// The primary in a target cell, pooled: better when the decision reading's
// one-sided test rejects no change in the better direction at the share;
// worse when both like for like readings do so in the worse direction.
export function primaryVerdict(r, share) {
  if (!r.measured || !r.comparable) return "unclear";
  if (r.pBetter <= share) return "better";
  if (likeReadings(r).every((x) => x.comparable && x.pWorse <= share)) return "worse";
  return "unclear";
}

// A guard: holds when its bound in the worse direction stays inside the
// loss; breaks when both like for like readings put even the better bound
// past the loss.
export function guardVerdict(metric, r, lossAbs) {
  if (!r.measured) return "not measured";
  if (!r.comparable) return "unclear";
  const up = higher(metric);
  if (up ? r.lo >= -lossAbs - EPS : r.hi <= lossAbs + EPS) return "holds";
  if (likeReadings(r).every((x) => x.comparable && (up ? x.hi < -lossAbs - EPS : x.lo > lossAbs + EPS))) return "breaks";
  return "unclear";
}

// The A/A half-width of every gate metric of a cell, pooled, against the
// record's loss: { <metric>: { halfWidth, loss, clusters, clustersNeeded,
// underpowered } }. clustersNeeded scales the clusters by the square of
// halfWidth over loss.
export function aaHalfWidths(cell, losses) {
  const out = {};
  for (const m of GATE_METRICS) {
    const r = cell.strata.pooled.metrics[m];
    if (!r || !r.measured) continue;
    const x = r.like?.lower ?? r;
    const halfWidth = Math.max(x.delta - x.lo, x.hi - x.delta);
    const loss = lossIn(m, losses[m], x.parent);
    const underpowered = halfWidth > loss + EPS;
    const clusters = r.clusters;
    out[m] = { halfWidth, loss, clusters, clustersNeeded: underpowered ? (loss > 0 ? Math.ceil(clusters * (halfWidth / loss) ** 2) : null) : clusters, underpowered };
  }
  return out;
}

// A change, bound or loss in its metric's units (fmt), and a value (fmtValue).
const fmt = (metric, x) => { const sign = x < 0 ? "-" : ""; const a = Math.abs(x); return metricOf(metric).unit === "points" ? `${sign}${(a * 100).toFixed(1)} points` : metric === "costPerReview" ? `${sign}$${a.toFixed(3)}` : metric === "secondsPerReview" ? `${sign}${a.toFixed(1)} s` : `${sign}${a.toFixed(3)}`; };
const fmtValue = (metric, x) => (metricOf(metric).unit === "points" ? `${(x * 100).toFixed(1)}%` : fmt(metric, x));

// Decides one look. `pairs` are compare.mjs sides ({parent, candidate});
// `aaPairs` the A/A pairs. Returns the decision with every cell's readings
// and verdicts; `decision` is null when the look ends no change.
export function decide({ id, record, pairs, look, stage = 2, final = false, aaPairs = [] }) {
  const bad = recordProblems(record);
  if (bad.length > 0) throw new Refusal(`the record cannot be decided:\n${bad.map((b) => `- ${b}`).join("\n")}`);
  if (!Number.isInteger(look) || look < 1) throw new Refusal(`the look number must be 1 or more, not ${look}`);
  if (![1, 2, 3].includes(stage)) throw new Refusal(`the stage must be 1, 2 or 3, not ${stage}`);
  const alpha = alphaAt(look);
  const share = alpha / GATE_METRICS.length;
  const comparison = comparePairs(pairs, { alpha: share, seed: id });
  if (comparison.problems.length > 0) throw new Refusal(`the runs cannot be paired:\n${comparison.problems.map((p) => `- ${p}`).join("\n")}`);
  const aa = aaPairs.length > 0 ? comparePairs(aaPairs, { alpha: share, seed: `${id}|aa` }) : null;
  if (aa && aa.problems.length > 0) throw new Refusal(`the A/A pairs cannot be paired:\n${aa.problems.map((p) => `- ${p}`).join("\n")}`);

  const primary = record.primary.metric;
  const losses = record.acceptableLoss;
  // What makes the change reverted (harms), and what keeps it from being
  // accepted (open), each with its kind.
  const harms = [];
  const open = [];
  const notMeasured = [];
  const cells = comparison.cells.map((cell) => {
    const where = `${cell.path} ${cell.reviewer}`;
    const isTarget = cell.path === record.target;
    const verdicts = {};
    for (const stratum of ["planted", "real", "pooled"]) {
      const s = cell.strata[stratum];
      // A single stratum is the pooled one (the same clusters): read once, as pooled.
      if (s === null || (stratum !== "pooled" && s === cell.strata.pooled)) continue;
      verdicts[stratum] = {};
      for (const m of GATE_METRICS) {
        const r = s.metrics[m];
        const lossAbs = lossIn(m, losses[m], r.parent);
        const at = `${where} (${stratum}): ${m}`;
        if (isTarget && stratum === "pooled" && m === primary) {
          const v = primaryVerdict(r, share);
          verdicts[stratum][m] = v;
          const said = `the primary ${at} is ${v} (change ${fmt(m, r.delta)}, one-sided p ${r.pBetter.toPrecision(3)} against ${share.toPrecision(3)})`;
          if (v === "worse") harms.push({ kind: "primary", text: said });
          else if (v === "unclear") open.push({ kind: "primary", text: said });
          continue;
        }
        const v = guardVerdict(m, r, lossAbs);
        verdicts[stratum][m] = v;
        const said = `${at} ${v} (change ${fmt(m, r.delta)}, bounds ${fmt(m, r.lo)} to ${fmt(m, r.hi)}, loss ${fmt(m, lossAbs)})`;
        if (v === "breaks") harms.push({ kind: "guard", text: said });
        else if (v === "unclear") open.push({ kind: "guard", text: said });
        else if (v === "not measured" && stratum === "pooled") notMeasured.push(`${where}: ${m}`);
      }
    }
    for (const stratum of ["planted", "real"]) if (cell.strata[stratum] !== null && cell.strata[stratum] === cell.strata.pooled) verdicts[stratum] = verdicts.pooled;
    for (const h of cell.hard.broken) harms.push({ kind: "hard", text: `${where}: hard rule broken: ${h}` });
    for (const h of cell.hard.unresolved) open.push({ kind: "hard", text: `${where}: hard rule open until a person rules: ${h}` });
    let aaWidths = null;
    const aaCell = aa?.cells.find((c) => c.path === cell.path && c.reviewer === cell.reviewer) ?? null;
    if (aaCell) {
      aaWidths = aaHalfWidths(aaCell, losses);
      for (const [m, w] of Object.entries(aaWidths)) if (w.underpowered) open.push({ kind: "aa", text: `${where}: the A/A half-width of ${m}, ${fmt(m, w.halfWidth)}, exceeds the acceptable loss ${fmt(m, w.loss)}; add cases or repeats (about ${w.clustersNeeded ?? "more"} clusters, up to 6 repeats) before stage 2` });
    }
    const pooledLoss = Object.fromEntries(GATE_METRICS.map((m) => [m, lossIn(m, losses[m], cell.strata.pooled.metrics[m].parent)]));
    return { ...cell, target: isTarget, verdicts, losses: pooledLoss, aa: aaWidths };
  });

  // The requirements of acceptance (failure 6).
  const missing = [];
  for (const p of record.paths) {
    const here = cells.filter((c) => c.path === p);
    if (here.length === 0) missing.push(`the ${p} path, which the change runs on, has no runs`);
    for (const r of REQUIRED_REVIEWERS[p] ?? []) if (!here.some((c) => c.reviewer === r)) missing.push(`the ${p} path has no runs by ${r}`);
  }
  for (const c of cells) if (c.repeatsUsed < MIN_REPEATS) missing.push(`${c.path} ${c.reviewer} pairs ${c.repeatsUsed} ${c.repeatsUsed === 1 ? "repeat" : "repeats"}, fewer than ${MIN_REPEATS}`);
  if (stage === 1) missing.push("stage 1 may only stop a change, never accept it");
  for (const m of missing) open.push({ kind: "requirement", text: m });

  let decision;
  let event = "decided";
  let stage3 = false;
  if (stage === 1) {
    decision = harms.length > 0 ? "stopped-early" : null;
    if (decision === null) event = "stage";
  } else if (record.aim === "measure") decision = "measured";
  else if (harms.length > 0) decision = "reverted";
  else if (open.length === 0) decision = "accepted";
  else if (stage === 2 && !final && open.every((o) => o.kind === "primary")) {
    decision = null;
    event = "stage";
    stage3 = true;
  } else decision = "inconclusive-reverted";

  const lines = [];
  if (decision === "accepted") lines.push(`accepted: the primary ${primary} is better on the ${record.target} path and every guard holds on every path and stratum`);
  else if (decision === "measured") lines.push("measured: the record's aim is measure, which is never accepted");
  else if (decision === "reverted" || decision === "stopped-early") lines.push(`${decision}: ${harms.map((h) => h.text).join("; ")}`);
  else if (stage3) lines.push(`inconclusive with every guard holding: stage 3 adds repeats 4 to 6 on the ${record.target} path; without it the change reverts. ${open.map((o) => o.text).join("; ")}`);
  else if (decision === null) lines.push(`stage 1 continues: nothing stops the change. Open: ${open.filter((o) => o.kind !== "requirement").map((o) => o.text).join("; ") || "none"}`);
  else lines.push(`inconclusive, so reverted: ${open.map((o) => o.text).join("; ")}`);
  if (notMeasured.length > 0) lines.push(`not measured by any review: ${notMeasured.join(", ")}`);

  return { id, look, alpha, share, stage, final, aim: record.aim ?? "quality", primary, target: record.target, acceptableLoss: { ...losses }, cells, requirements: { met: missing.length === 0, missing }, harms: harms.map((h) => h.text), open: open.map((o) => o.text), stage3, decision, event, reason: lines.join(" ") };
}

// ---------------------------------------------------------------------------
// The ledger line (PLAN 4.8).

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
function runRow(side, role) {
  const costs = side.jobs.map((j) => j.costUsd).filter((x) => typeof x === "number" && Number.isFinite(x));
  const ms = side.jobs.map((j) => j.wallMs).filter((x) => typeof x === "number" && Number.isFinite(x));
  return { runId: side.runId, role, path: side.path, reviewer: side.reviewer, model: side.model, servedModel: side.servedModel, config: side.config, repeats: side.repeats, split: side.split, splitHash: side.splitHash, costUsd: costs.length === 0 ? null : sum(costs), reviews: side.jobs.length, minutes: ms.length === 0 ? null : sum(ms) / 60_000 };
}

const pick = (r, verdict, loss) => ({ parent: r.parent, candidate: r.candidate, delta: r.delta, lo: r.lo, hi: r.hi, pBetter: r.pBetter, pWorse: r.pWorse, changed: r.changed, clusters: r.clusters, method: r.method, measured: r.measured, comparable: r.comparable, verdict, loss });
function byPath(result, stratum) {
  const out = {};
  for (const c of result.cells) {
    const s = c.strata[stratum];
    if (s === null) continue;
    (out[c.path] ??= {})[c.reviewer] = Object.fromEntries(GATE_METRICS.map((m) => [m, pick(s.metrics[m], c.verdicts[stratum][m], lossIn(m, result.acceptableLoss[m], s.metrics[m].parent))]));
  }
  return Object.keys(out).length === 0 ? null : out;
}

export function decisionLine(result, { pairs, at = new Date().toISOString(), pr = null }) {
  const runs = pairs.flatMap(({ parent, candidate }) => [runRow(parent, "parent"), runRow(candidate, "candidate")]);
  const candidates = pairs.map((p) => p.candidate);
  const costs = candidates.flatMap((s) => s.jobs.map((j) => j.costUsd)).filter((x) => typeof x === "number" && Number.isFinite(x));
  const ms = candidates.flatMap((s) => s.jobs.map((j) => j.wallMs)).filter((x) => typeof x === "number" && Number.isFinite(x));
  const causes = {};
  for (const p of pairs) if (p.candidate.causes) (causes[p.candidate.path] ??= {})[p.candidate.reviewer] = p.candidate.causes.misses ?? p.candidate.causes;
  const aa = {};
  for (const c of result.cells) if (c.aa) (aa[c.path] ??= {})[c.reviewer] = c.aa;
  const hard = {};
  for (const c of result.cells) (hard[c.path] ??= {})[c.reviewer] = c.hard;
  return {
    v: 1,
    id: result.id,
    at,
    event: result.event,
    runs,
    look: result.look,
    alpha: result.alpha,
    share: result.share,
    primary: { metric: result.primary, target: result.target },
    acceptableLoss: result.acceptableLoss,
    results: byPath(result, "pooled"),
    strata: { planted: byPath(result, "planted"), real: byPath(result, "real"), pooled: byPath(result, "pooled") },
    ...(Object.keys(aa).length > 0 ? { aa } : {}),
    hard,
    requirements: result.requirements,
    causes,
    wording: null,
    stage: result.stage,
    decision: result.decision,
    reason: result.reason,
    spendUsd: costs.length === 0 ? null : sum(costs),
    laptopReviews: candidates.filter((s) => s.path === "laptop").reduce((n, s) => n + s.jobs.length, 0),
    minutes: ms.length === 0 ? null : sum(ms) / 60_000,
    pr,
  };
}

// ---------------------------------------------------------------------------
// The command.

// A side named on the command line: <run>[#<config>][@<repeats>].
export function parseSide(spec) {
  const m = /^(.+?)(?:#([^#@]+))?(?:@(\d+(?:,\d+)*))?$/.exec(spec);
  if (!m) throw new Refusal(`a side is <run>[#<config>][@<repeats>], not ${spec}`);
  return { run: m[1], config: m[2] ?? null, repeats: m[3] ? m[3].split(",").map(Number) : null };
}

// The compare.mjs pairs one --pair or --aa value names.
export function pairsFromSpec(spec, { specs = null, decisions }) {
  const cut = spec.indexOf("=");
  if (cut <= 0 || cut === spec.length - 1) throw new Refusal(`a pair is <parent>=<candidate>, not ${spec}`);
  const p = parseSide(spec.slice(0, cut));
  const c = parseSide(spec.slice(cut + 1));
  const ps = loadSides({ run: p.run, specs, repeats: p.repeats, decisions });
  const cs = loadSides({ run: c.run, specs, repeats: c.repeats, decisions });
  try {
    return pairsOf(ps, cs, { parentConfig: p.config, candidateConfig: c.config });
  } catch (error) {
    throw new Refusal(`${spec}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const o = { change: null, record: null, pairs: [], aa: [], stage: 2, final: false, ledger: LEDGER, decisions: decisionsPath, specs: null, pr: null, look: null, dryRun: false, json: false };
  const value = (i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Refusal(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--change") o.change = value(i++);
    else if (a === "--record") o.record = value(i++);
    else if (a === "--pair") o.pairs.push(value(i++));
    else if (a === "--aa") o.aa.push(value(i++));
    else if (a === "--stage") o.stage = Number(value(i++));
    else if (a === "--final") o.final = true;
    else if (a === "--ledger") o.ledger = resolve(value(i++));
    else if (a === "--decisions") o.decisions = resolve(value(i++));
    else if (a === "--specs") o.specs = value(i++);
    else if (a === "--pr") o.pr = Number(value(i++));
    else if (a === "--look") o.look = Number(value(i++));
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else throw new Refusal(`unknown argument ${a}`);
  }
  if ((o.change === null) === (o.record === null)) throw new Refusal("name the change with --change <id>, or a record with --record <file> and --dry-run");
  if (o.record !== null && !o.dryRun) throw new Refusal("--record decides a change that is not in the ledger, so it needs --dry-run: nothing is written");
  if (o.look !== null && !o.dryRun) throw new Refusal("--look is for --dry-run; a live decision counts its look from the ledger");
  if (o.pairs.length === 0) throw new Refusal("name the runs with --pair <parent>=<candidate>");
  return o;
}

function render(result) {
  const out = [`${result.id}: look ${result.look}, alpha ${result.alpha.toPrecision(3)} (0.05 / (t (t + 1))), ${result.share.toPrecision(3)} per metric, stage ${result.stage}. Primary ${result.primary} on the ${result.target} path.`];
  for (const c of result.cells) {
    out.push("");
    out.push(`${c.path} ${c.reviewer}${c.target ? " (target)" : ""}, ${c.repeatsUsed} repeats: ${c.pairs.map((p) => `${p.parent.runId} against ${p.candidate.runId}`).join("; ")}`);
    out.push("| Metric | Stratum | Parent | Candidate | Change | Bounds | Loss | Verdict |");
    out.push("|---|---|---|---|---|---|---|---|");
    for (const stratum of ["planted", "real", "pooled"]) {
      if (!c.verdicts[stratum] || (stratum === "pooled" && (c.strata.pooled === c.strata.planted || c.strata.pooled === c.strata.real))) continue;
      for (const m of GATE_METRICS) {
        const r = c.strata[stratum].metrics[m];
        out.push(`| ${m} | ${stratum !== "pooled" && c.strata[stratum] === c.strata.pooled ? `${stratum}, pooled` : stratum} | ${r.measured ? fmtValue(m, r.parent) : "n/a"} | ${r.measured ? fmtValue(m, r.candidate) : "n/a"} | ${r.measured ? fmt(m, r.delta) : "n/a"} | ${r.measured ? `${fmt(m, r.lo)} to ${fmt(m, r.hi)}` : "n/a"} | ${fmt(m, lossIn(m, result.acceptableLoss[m], r.parent))} | ${c.verdicts[stratum][m]} |`);
      }
    }
  }
  out.push("");
  out.push(`Decision: ${result.decision ?? "none at this look"}. ${result.reason}`);
  return out.join("\n");
}

function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const decisions = readRulings(o.decisions);
    const pairs = o.pairs.flatMap((s) => pairsFromSpec(s, { specs: o.specs, decisions }));
    const aaPairs = o.aa.flatMap((s) => pairsFromSpec(s, { specs: o.specs, decisions }));
    if (o.dryRun) {
      const record = o.record !== null ? JSON.parse(readFileSync(resolve(o.record), "utf8")) : readLedger(o.ledger).find((l) => l.event === "proposed" && l.id === o.change)?.record;
      if (!record) throw new Refusal(`the ledger ${o.ledger} holds no proposed change ${o.change}`);
      const look = o.look ?? (existsSync(o.ledger) ? lookOf(readLedger(o.ledger)) : 1);
      const result = decide({ id: o.change ?? "dry-run", record, pairs, look, stage: o.stage, final: o.final, aaPairs });
      console.log(o.json ? JSON.stringify(decisionLine(result, { pairs, pr: o.pr }), null, 2) : `${render(result)}\n(dry run: nothing written)`);
      process.exit(0);
    }
    mkdirSync(dirname(o.ledger), { recursive: true });
    const lock = lockLedger(o.ledger);
    let line;
    let result;
    try {
      const lines = readLedger(o.ledger);
      const problems = validationProblems(lines);
      if (problems.length > 0) throw new Refusal(`refused: no live decision before a passing validation of this rule:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      const proposed = lines.find((l) => l.event === "proposed" && l.id === o.change);
      if (!proposed) throw new Refusal(`refused: the ledger holds no proposed change ${o.change}`);
      const done = lines.find((l) => l.id === o.change && l.event === "decided");
      if (done) throw new Refusal(`refused: ${o.change} is already decided (${done.decision} at look ${done.look})`);
      const record = proposed.record;
      const wrong = pairs.filter((p) => record.commit && p.candidate.build?.commit && p.candidate.build.commit !== record.commit);
      if (wrong.length > 0) throw new Refusal(`refused: the candidate run ${wrong[0].candidate.runId} was built from ${wrong[0].candidate.build.commit.slice(0, 8)}, not the change's commit ${record.commit.slice(0, 8)}`);
      result = decide({ id: o.change, record, pairs, look: lookOf(lines), stage: o.stage, final: o.final, aaPairs });
      line = decisionLine(result, { pairs, pr: o.pr });
      if (!lock.held()) throw new Refusal(`the ledger lock ${o.ledger}.lock was taken over while this decision ran; nothing is written, decide again`);
      appendFileSync(o.ledger, `${JSON.stringify(line)}\n`);
    } finally {
      lock.release();
    }
    console.log(o.json ? JSON.stringify(line, null, 2) : `${render(result)}\nWritten to ${o.ledger}.`);
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Refusal || error instanceof ToolError ? error.message : error.stack);
    process.exit(2);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
