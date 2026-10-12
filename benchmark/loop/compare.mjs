#!/usr/bin/env node
// The paired comparison of two runs on the same cases and rules: candidate
// minus parent, on every issue-level metric of the acceptance rule
// (PLAN-benchmark 4.11), by the paired sign-flip test over clusters of
// lib/interval.mjs. decide.mjs reads it; a person reads it here:
//
//   node benchmark/loop/compare.mjs <parent> <candidate>
//        [--config <c>] [--parent-config <c>] [--candidate-config <c>]
//        [--parent-repeats 1,2] [--candidate-repeats 3]
//        [--specs <folder>] [--parent-specs <folder>] [--candidate-specs <folder>]
//        [--alpha 0.05] [--decisions <file>] [--json]
//
// <parent> and <candidate> are run folders, or run ids under
// benchmark/results (fetch a published one with fetch-run.mjs). Both are
// scored from their saved files by score.mjs, under the rulings of the
// adjudication file (--decisions). Without --config, every configuration
// the two runs share is compared. --parent-repeats and --candidate-repeats
// pick repeats, so two disjoint repeats of one run make an A/A pair.
// --specs, as in causes.mjs, scores a run against other specs (a folder
// name that is not a path is looked up inside the run: cases-v2).
//
// The unit drawn is the cluster: the case on a planted suite, the
// repository group on a real one, with every repeat, truth item and finding
// of the case inside it. Each metric is a ratio of sums ({hit, of}) over
// the clusters, and its paired change is tested by swapping whole clusters
// between the two sides, never reviews. Strata: planted (planted cases),
// real (real pull requests and clean real changes) and pooled (all), within
// one path and one reviewer; a cell is that path and reviewer.
//
// Each metric gives three readings. The decision reading takes the bound
// worse for the change (4.11): the candidate's lower bound against the
// parent's upper bound, where an unresolved finding is wrong for the
// candidate and right for the parent, and an unresolved match on a truth
// item is a miss for the candidate and a find for the parent. The two like
// for like readings (lower against lower, upper against upper) say whether
// anything changed; compare.mjs prints those as its verdict: better, worse,
// mixed (one bound each way) or no change, at --alpha split across the
// gate metrics and both directions, and halved again across the two bounds
// of a metric whose bounds differ.
//
// Exit codes: 0 compared; 2 refused (the runs cannot be paired) or failed.
//
// Failure list, written before the code:
// 1. Repeats are counted as independent cases, so three reviews that agree
//    narrow the bound: every repeat of a case is summed into its cluster
//    and only clusters are swapped.
// 2. Two runs on different cases, under different rules, of different
//    suites, paths or reviewers are compared as a change: each difference
//    refuses the pair, by name.
// 3. A held-out (test split) run reaches the loop: refused.
// 4. An A/A pair drawn from one run puts the same reviews on both sides:
//    the same run and configuration on both sides needs disjoint repeats.
// 5. Unresolved findings flatter the candidate, or an unresolved match on
//    a truth item counts as its find: the decision reading takes the bound
//    worse for the change, recall included.
// 6. A change is read from unresolved findings alone (the candidate's lower
//    bound below the parent's upper bound in an A/A pair): the verdict is
//    read like for like, lower against lower and upper against upper.
// 7. Sides with different repeat counts are swapped as if exchangeable: the
//    first repeats of each side are used, as many as the smaller side has.
// 8. A metric with nothing to count reads as a pass, or as perfect (no
//    checks reads as 1): a metric no cluster measures is "not measured",
//    and one only one side measures is "not comparable".
// 9. Cost or time unknown on one side compares dollars with nothing: a
//    cluster with a known value on one side only makes the metric not
//    comparable.
// 10. Pooling two suites mixes their case ids: a cluster key carries its
//    suite.
// 11. A metric with two bounds gets two chances to reject no change in one
//    direction within one share: each like for like reading is tested at
//    half the share, or once at the whole share when both are the same sums.
//
// The scanner variant (4.11 K1 to K4, plan amendment A1) reads two runs'
// scans instead, sample by sample (scanSide below); decide.mjs decides.
// Failure list for that part, written before the code:
// 12. A candidate a change altered (its severity, its message, a finding
//    dedup merged into it) reads as kept: the content compared is every
//    field but the id, which only numbers candidates in report order, so an
//    altered candidate is one removed and one added.
// 13. A scan that failed or never ran reads as the removal of everything it
//    would have raised: a sample with no scan on either side, or two sides
//    with different samples, is refused.
// 14. Two candidates with the same content in one sample count as one: the
//    candidates are compared as a multiset, each copy counted.
// 15. A ruling moves a candidate that frozen evidence decides (a hit, or a
//    candidate on a clean control): rulings act only on the candidates the
//    scan scorer left unresolved.
// 16. A candidate ruled false under one version of its case's spec counts
//    as false under a revised one, where it may sit on an issue the spec
//    now lists: a candidate ruling counts only when it names the spec
//    version (target.specHash, lib/rulings.mjs specHashOf) the run is
//    scored against, and one naming another version is refused with the
//    reason. Two runs scored against different versions of a case's spec
//    are refused.
import { existsSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resultsRoot } from "../lib/index.mjs";
import { clusterFn, pairedBounds, seedOf } from "../lib/interval.mjs";
import { candidateRuling, readDecisions, specHashOf } from "../lib/rulings.mjs";
import { SCAN_PRECISION, SCAN_RULES, scoreScanAttempts } from "../lib/scan-score.mjs";
import { PRECISION, canonical, originOf, rulesDifferences } from "../lib/score.mjs";
import { decisionsPath, loadRun, scoreRun } from "../score.mjs";

// The metrics, by the names benchmark/loop/levers.json gives the guards.
// `gate` metrics take a predeclared loss and decide; the others are
// reported. `unit` says how a loss reads: points (a loss of 2 is 0.02),
// count (findings per clean review, as given), or a fraction of the
// parent's value. `job(j, bound)` is one review's {hit, of}; `bounded`
// metrics differ between the lower and the upper bound.
const OPEN = new Set(PRECISION.unresolved);
const isCriticalMajor = (b) => b.severity === "critical" || b.severity === "major";
// The truth items a review did not find but showed an unresolved match on.
const openMatches = (j, pick) => j.bugs.filter((b) => pick(b) && !b.found && j.findings.some((f) => f.bug === b.id && OPEN.has(f.outcome))).length;
const recallOf = (j, bound, pick) => {
  const items = j.bugs.filter(pick);
  const hit = items.filter((b) => b.found).length;
  return { hit: bound === "upper" ? hit + openMatches(j, pick) : hit, of: items.length };
};
const none = { hit: 0, of: 0 };

export const METRICS = [
  { name: "recall", label: "issue recall", better: "higher", unit: "points", gate: true, bounded: true, job: (j, bound) => recallOf(j, bound, () => true) },
  { name: "criticalMajorRecall", label: "critical and major issue recall", better: "higher", unit: "points", gate: true, bounded: true, job: (j, bound) => recallOf(j, bound, isCriticalMajor) },
  { name: "precision", label: "displayed precision", better: "higher", unit: "points", gate: true, bounded: true, job: (j, bound) => ({ hit: j.precision.correct + (bound === "upper" ? j.precision.unresolved : 0), of: j.precision.of }) },
  { name: "uniqueIssuePrecision", label: "unique-issue precision", better: "higher", unit: "points", gate: false, bounded: true, job: (j, bound) => ({ hit: j.issues.correct + (bound === "upper" ? j.issues.unresolved : 0), of: j.issues.of }) },
  { name: "severityAgreement", label: "severity agreement (exact)", better: "higher", unit: "points", gate: true, bounded: false, job: (j) => { const judged = j.findings.filter((f) => f.outcome === "hit" && f.severityAgreement != null); return { hit: judged.filter((f) => f.severityAgreement === "exact").length, of: judged.length }; } },
  { name: "incompleteRate", label: "incomplete rate", better: "lower", unit: "points", gate: true, bounded: false, job: (j) => ({ hit: j.status === "complete" ? 0 : 1, of: 1 }) },
  { name: "redundancy", label: "redundancy", better: "lower", unit: "points", gate: true, bounded: false, job: (j) => ({ hit: j.precision.of - j.issues.of, of: j.precision.of }) },
  { name: "cleanFindings", label: "findings per clean review", better: "lower", unit: "count", gate: true, bounded: false, job: (j) => (j.clean ? { hit: j.precision.of, of: 1 } : none) },
  { name: "costPerReview", label: "cost per review", better: "lower", unit: "fraction", gate: true, bounded: false, job: (j) => (typeof j.costUsd === "number" && Number.isFinite(j.costUsd) ? { hit: j.costUsd, of: 1 } : none) },
  { name: "secondsPerReview", label: "seconds per review", better: "lower", unit: "fraction", gate: true, bounded: false, job: (j) => (typeof j.wallMs === "number" && Number.isFinite(j.wallMs) ? { hit: j.wallMs / 1000, of: 1 } : none) },
];
export const GATE_METRICS = METRICS.filter((m) => m.gate).map((m) => m.name);
export const metricOf = (name) => METRICS.find((m) => m.name === name);

// A metric's loss in its own units: points to a fraction, a count as given,
// a fraction of the parent's value times that value.
export function lossIn(metric, loss, parentValue) {
  const m = metricOf(metric);
  if (m.unit === "points") return loss / 100;
  if (m.unit === "fraction") return loss * parentValue;
  return loss;
}

const STRATA = { planted: "planted", real: "real" };
const plus = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });
const ratioOf = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const configReviewer = (config) => String(config).replace(/-graph-(on|off)$/, "");

// A side of a comparison: one configuration of one run, its scored first
// attempts (lib/score.mjs scoreJob, plus budgetRefused and
// undeliveredComplete) on the repeats picked. caseIds and repeats are read
// from the jobs.
export function makeSide({ runId, suite = "planted", split = "dev", splitHash = null, path = "laptop", reviewer = null, model = null, servedModel = null, config, rules, build = null, groups = null, jobs, causes = null }) {
  return {
    runId,
    suite,
    origin: originOf(suite),
    split,
    splitHash,
    path,
    reviewer: reviewer ?? configReviewer(config),
    model,
    servedModel,
    config,
    rules,
    build,
    groups,
    caseIds: [...new Set(jobs.map((j) => j.caseId))].sort(),
    repeats: [...new Set(jobs.map((j) => j.repeat))].sort((a, b) => a - b),
    jobs,
    causes,
  };
}

// Why two sides cannot be paired; empty when they can.
export function pairProblems(parent, candidate) {
  const out = [];
  const name = (s) => `${s.runId} ${s.config}`;
  for (const s of [parent, candidate]) if (s.split === "test") out.push(`${name(s)} is a held-out (test split) run; the loop never reads one (PLAN 4.10)`);
  for (const s of [parent, candidate]) if (s.origin === null || s.origin === "injected") out.push(`${name(s)} is from the ${s.suite} suite, which is held out or unknown to the loop`);
  if (parent.suite !== candidate.suite) out.push(`the suites differ: ${parent.suite} then ${candidate.suite}`);
  if (parent.splitHash !== candidate.splitHash) out.push(`the split hashes differ: ${parent.splitHash} then ${candidate.splitHash}`);
  if (parent.path !== candidate.path) out.push(`the paths differ: ${parent.path} then ${candidate.path}`);
  if (parent.reviewer !== candidate.reviewer) out.push(`the reviewers differ: ${parent.reviewer} then ${candidate.reviewer}`);
  if ((parent.model ?? null) !== (candidate.model ?? null)) out.push(`the models differ: ${parent.model} then ${candidate.model}`);
  out.push(...rulesDifferences(parent.rules, candidate.rules));
  const a = parent.caseIds.join("\n");
  const b = candidate.caseIds.join("\n");
  if (a !== b) {
    const only = (x, y) => x.caseIds.filter((id) => !y.caseIds.includes(id));
    out.push(`the case sets differ: ${only(parent, candidate).length} cases only in the parent (${only(parent, candidate).slice(0, 3).join(", ")}), ${only(candidate, parent).length} only in the candidate (${only(candidate, parent).slice(0, 3).join(", ")})`);
  }
  if (parent.runId === candidate.runId && parent.config === candidate.config && parent.repeats.some((r) => candidate.repeats.includes(r))) out.push(`the same reviews are on both sides (${name(parent)}, repeats ${parent.repeats.join(",")} and ${candidate.repeats.join(",")}); an A/A pair from one run needs disjoint repeats`);
  if (parent.jobs.length === 0 || candidate.jobs.length === 0) out.push("a side holds no review");
  return out;
}

// The first `n` repeats a side holds (failure 7).
const firstRepeats = (side, n) => side.jobs.filter((j) => side.repeats.indexOf(j.repeat) < n);

// Sums a metric over a stratum's pairs into clusters: [{key, a, b}] sorted
// by key, `a` the parent's, `b` the candidate's.
function clustered(pairs, metric, boundA, boundB) {
  const out = new Map();
  for (const { parent, candidate, n } of pairs) {
    const clusterOf = clusterFn(parent.groups ?? candidate.groups ?? null);
    const add = (jobs, side, bound) => {
      for (const j of jobs) {
        const key = `${parent.suite}|${clusterOf(j.caseId) ?? j.caseId}`;
        const x = out.get(key) ?? { a: { hit: 0, of: 0 }, b: { hit: 0, of: 0 } };
        x[side] = plus(x[side], metric.job(j, bound));
        out.set(key, x);
      }
    };
    add(firstRepeats(parent, n), "a", boundA);
    add(firstRepeats(candidate, n), "b", boundB);
  }
  return [...out].map(([key, x]) => ({ key, ...x })).sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

// One reading of one metric: the paired change b minus a with its bounds at
// `alpha`, and the chance with no change of one at least as good (pBetter)
// or at least as bad (pWorse) for the candidate.
function reading(clusters, metric, { seed, alpha }) {
  const total = clusters.reduce((t, c) => ({ a: plus(t.a, c.a), b: plus(t.b, c.b) }), { a: { hit: 0, of: 0 }, b: { hit: 0, of: 0 } });
  const measured = total.a.of > 0 || total.b.of > 0;
  const oneSided = clusters.some((c) => (c.a.of > 0) !== (c.b.of > 0));
  const comparable = measured && total.a.of > 0 && total.b.of > 0 && !(metric.unit === "fraction" && oneSided);
  const base = { parent: ratioOf(total.a), candidate: ratioOf(total.b), parentSums: total.a, candidateSums: total.b, measured, comparable };
  if (!measured) return { ...base, delta: 0, lo: 0, hi: 0, pBetter: 1, pWorse: 1, changed: 0, clusters: 0, method: null };
  const r = pairedBounds({ pairs: clusters, seed, alpha });
  const higher = metric.better === "higher";
  return { ...base, delta: r.delta, lo: r.lower, hi: r.upper, pBetter: higher ? r.pUpper : r.pLower, pWorse: higher ? r.pLower : r.pUpper, changed: r.changed, clusters: r.clusters, method: r.method };
}

const sameSums = (x, y) => x.length === y.length && x.every((c, i) => c.key === y[i].key && c.a.hit === y[i].a.hit && c.a.of === y[i].a.of && c.b.hit === y[i].b.hit && c.b.of === y[i].b.of);

// Every reading of one metric over one stratum's pairs. For a bounded
// metric: the decision reading (candidate lower, parent upper) and the like
// for like readings; for the others the one reading serves as all three.
function metricResult(pairs, metric, { seedParts, alpha }) {
  const seedFor = (variant) => seedOf(...seedParts, metric.name, variant);
  if (!metric.bounded) {
    const one = reading(clustered(pairs, metric, "lower", "lower"), metric, { seed: seedFor("decision"), alpha });
    return { metric: metric.name, ...one, like: null };
  }
  const lower = clustered(pairs, metric, "lower", "lower");
  const upper = clustered(pairs, metric, "upper", "upper");
  const decisionSums = clustered(pairs, metric, "upper", "lower");
  const lowerReading = reading(lower, metric, { seed: seedFor("lower"), alpha });
  // With nothing unresolved the three readings are the same sums: tested once.
  const upperReading = sameSums(upper, lower) ? lowerReading : reading(upper, metric, { seed: seedFor("upper"), alpha });
  const decision = sameSums(decisionSums, lower) ? lowerReading : reading(decisionSums, metric, { seed: seedFor("decision"), alpha });
  const strip = ({ parent, candidate, delta, lo, hi, pBetter, pWorse, measured, comparable, changed, clusters, method }) => ({ parent, candidate, delta, lo, hi, pBetter, pWorse, measured, comparable, changed, clusters, method });
  return { metric: metric.name, ...decision, like: { same: upperReading === lowerReading, lower: strip(lowerReading), upper: strip(upperReading) } };
}

// The verdict of the like for like readings at `alpha` in each direction:
// whether the candidate is better, worse, both on different bounds (mixed),
// or neither. A metric with two bounds has two readings and so two chances
// to reject no change in a direction: each is tested at half of `alpha`,
// which keeps the chance of a wrong verdict in a direction at `alpha`
// (failure 11). Splitting is kept over asking both bounds to agree, because
// a change in one bound alone (a candidate that adds findings nobody has
// ruled on moves the lower bound and not the upper) is a change to report.
// When both bounds are the same sums (nothing unresolved), the one reading
// is tested once at the whole of `alpha`.
export function changeVerdict(result, alpha) {
  if (!result.measured) return "not measured";
  if (!result.comparable) return "not comparable";
  const readings = !result.like ? [result] : result.like.same ? [result.like.lower] : [result.like.lower, result.like.upper];
  const each = alpha / readings.length;
  const better = readings.some((r) => r.comparable && r.pBetter <= each);
  const worse = readings.some((r) => r.comparable && r.pWorse <= each);
  return better && worse ? "mixed" : better ? "better" : worse ? "worse" : "no change";
}

// The comparison of every pair, grouped into cells by path and reviewer,
// each with its strata. `alpha` is the one-sided level of every bound;
// `metrics` limits the metrics computed (all by default); `seed` names the
// comparison in every seed (a change id). Returns { cells, problems }; with
// problems, no cell is computed.
export function comparePairs(pairs, { alpha, seed = "compare", metrics = METRICS.map((m) => m.name) } = {}) {
  if (!(alpha > 0 && alpha < 1)) throw new Error("comparePairs needs an alpha between 0 and 1");
  const problems = [];
  for (const { parent, candidate } of pairs) problems.push(...pairProblems(parent, candidate).map((p) => `${parent.runId} ${parent.config} against ${candidate.runId} ${candidate.config}: ${p}`));
  const byCell = new Map();
  for (const p of pairs) {
    const key = `${p.parent.path}\0${p.parent.reviewer}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(p);
  }
  for (const list of byCell.values()) {
    const suites = list.map((p) => p.parent.suite);
    const twice = suites.filter((s, i) => suites.indexOf(s) !== i);
    if (twice.length > 0) problems.push(`${list[0].parent.path} ${list[0].parent.reviewer}: the suite ${twice[0]} is paired twice; one pair per suite, path and reviewer`);
  }
  if (problems.length > 0) return { cells: [], problems };
  const wanted = METRICS.filter((m) => metrics.includes(m.name));
  const cells = [...byCell.values()].map((list) => {
    const { path, reviewer } = list[0].parent;
    const used = list.map(({ parent, candidate }) => ({ parent, candidate, n: Math.min(parent.repeats.length, candidate.repeats.length) }));
    const strata = {};
    const present = Object.keys(STRATA).filter((s) => used.some((p) => p.parent.origin === s));
    for (const stratum of [...present, "pooled"]) {
      const inside = stratum === "pooled" ? used : used.filter((p) => p.parent.origin === stratum);
      // A single stratum is the pooled one: the same clusters, tested once.
      if (stratum === "pooled" && present.length === 1) {
        strata.pooled = strata[present[0]];
        continue;
      }
      strata[stratum] = { metrics: Object.fromEntries(wanted.map((m) => [m.name, metricResult(inside, m, { seedParts: [seed, path, reviewer, stratum], alpha })])) };
    }
    for (const s of Object.keys(STRATA)) strata[s] ??= null;
    return {
      path,
      reviewer,
      repeatsUsed: Math.min(...used.map((p) => p.n)),
      pairs: used.map(({ parent, candidate, n }) => ({ suite: parent.suite, parent: { runId: parent.runId, config: parent.config, repeats: parent.repeats.slice(0, n) }, candidate: { runId: candidate.runId, config: candidate.config, repeats: candidate.repeats.slice(0, n) } })),
      strata,
      hard: hardRules(used),
    };
  });
  return { cells, problems: [] };
}

// The hard rules (4.11), which refuse a change whatever the bounds read,
// over every pair of a cell. `broken` holds the rules broken on the frozen
// numbers; `unresolved` those broken only when an unresolved match on a
// critical item counts as a find for the parent, which needs a person's
// ruling before anything is accepted.
// - A critical issue found in 2 or more reviews of the parent is found in
//   1 or fewer of the candidate's (each side with 2 reviews or more).
// - A clean control shows a finding in 2 or more of the candidate's
//   reviews where it did in 1 or fewer of the parent's.
// - A review is incomplete by a budget refusal in more of the candidate's
//   reviews of a case than of the parent's.
// - A candidate review is complete while a changed range was not delivered.
export function hardRules(used) {
  const broken = [];
  const unresolved = [];
  for (const { parent, candidate, n } of used) {
    const a = firstRepeats(parent, n);
    const b = firstRepeats(candidate, n);
    for (const id of parent.caseIds) {
      const ra = a.filter((j) => j.caseId === id);
      const rb = b.filter((j) => j.caseId === id);
      if (ra.length >= 2 && rb.length >= 2) {
        for (const bug of ra[0].bugs.filter((x) => x.severity === "critical")) {
          const foundA = ra.filter((j) => j.bugs.find((x) => x.id === bug.id)?.found).length;
          const openA = ra.filter((j) => openMatches({ ...j, bugs: j.bugs.filter((x) => x.id === bug.id) }, () => true) > 0).length;
          const foundB = rb.filter((j) => j.bugs.find((x) => x.id === bug.id)?.found).length;
          const what = `${id} ${bug.id} (critical): found in ${foundA} of ${ra.length} parent reviews, in ${foundB} of ${rb.length} candidate reviews`;
          if (foundA >= 2 && foundB <= 1) broken.push(what);
          else if (foundA + openA >= 2 && foundB <= 1) unresolved.push(`${what}; ${openA} more parent reviews hold an unresolved match on it`);
        }
      }
      if (ra[0]?.clean && rb.length >= 2) {
        const withA = ra.filter((j) => j.precision.of > 0).length;
        const withB = rb.filter((j) => j.precision.of > 0).length;
        if (withB >= 2 && withA <= 1) broken.push(`${id}: a clean control shows findings in ${withB} of ${rb.length} candidate reviews, in ${withA} of ${ra.length} parent reviews`);
      }
      const refusedA = ra.filter((j) => j.budgetRefused).length;
      const refusedB = rb.filter((j) => j.budgetRefused).length;
      if (refusedB > refusedA) broken.push(`${id}: ${refusedB} candidate reviews incomplete by a budget refusal, against ${refusedA} parent reviews`);
    }
    for (const j of b) if (j.undeliveredComplete) broken.push(`${j.jobId}: the review is complete while a changed range was not delivered`);
  }
  return { broken, unresolved };
}

// ---------------------------------------------------------------------------
// Reading saved runs.

// A run folder from a folder path or a run id under benchmark/results.
export const runFolder = (run) => (existsSync(run) ? resolve(run) : join(resultsRoot, run));
// A specs folder: a path, or a folder name inside the run (cases-v2).
const specsFolder = (folder, specs) => (specs === null || specs === undefined ? null : existsSync(specs) ? resolve(specs) : join(folder, specs));

// What a review's report says beyond its score: whether it was refused by
// the budget, and whether it is complete with a changed range undelivered.
const BUDGET_REFUSED = /budget refused before /;
function reportFacts(report) {
  const c = report?.completion ?? null;
  const missing = Array.isArray(c?.missing) ? c.missing : [];
  const unread = c?.coverage?.unread;
  return { budgetRefused: missing.some((l) => BUDGET_REFUSED.test(String(l))), undeliveredComplete: c?.status === "complete" && Array.isArray(unread) && unread.length > 0 };
}

// Every configuration of a saved run as a side, scored by score.mjs under
// the rulings in `decisions` ({lines, people, hash}, lib/rulings.mjs
// readDecisions). `repeats` (a list) keeps only those repeats.
export function loadSides({ run, specs = null, repeats = null, decisions = { lines: [], people: [] } }) {
  const folder = runFolder(run);
  const loaded = loadRun(folder, { specsDir: specsFolder(folder, specs) });
  if ((loaded.manifest.mode ?? "review") !== "review") throw new Error(`${basename(folder)} is a ${loaded.manifest.mode} run; the reviewer loop compares review runs`);
  const { score, jobs } = scoreRun(loaded, { decisions: decisions.lines, people: decisions.people });
  const facts = new Map(loaded.attempts.filter((a) => a.attempt === 1).map((a) => [`${a.case}\0${a.config}\0${a.repeat}`, reportFacts(a.report)]));
  const m = loaded.manifest;
  const runId = m.runId ?? basename(folder);
  return Object.keys(score.byConfig).map((config) => {
    const reviewer = loaded.attempts.find((a) => a.config === config)?.row?.reviewer ?? configReviewer(config);
    const info = m.reviewers?.[reviewer] ?? (m.reviewer?.name === reviewer ? m.reviewer : null);
    const mine = jobs.filter((j) => j.config === config && (repeats === null || repeats.includes(j.repeat)));
    return makeSide({
      runId,
      suite: score.suite,
      split: score.split,
      splitHash: score.splitHash,
      path: score.path,
      reviewer,
      model: info?.model ?? null,
      servedModel: info?.servedModel ?? null,
      config,
      rules: { version: score.rules.version, hash: score.rules.hash },
      build: score.build,
      groups: score.intervals?.groups ?? null,
      jobs: mine.map((j) => ({ ...j, ...(facts.get(`${j.case}\0${j.config}\0${j.repeat}`) ?? { budgetRefused: false, undeliveredComplete: false }) })),
      causes: score.byConfig[config].causes ?? null,
    });
  });
}

// The adjudication file's rulings, for loadSides.
export function readRulings(path = decisionsPath) {
  const d = readDecisions(path);
  return { lines: d.lines, people: d.people, hash: d.hash };
}

// ---------------------------------------------------------------------------
// The scanner variant: one side of a scanner change.

// A candidate's content: every field but its id (failure 12).
const contentOf = (c) => {
  const rest = { ...c };
  delete rest.id;
  return canonical(rest);
};

// One run's scans as a side of a scanner change: each planned sample's
// first attempt scored by the scan scorer (lib/scan-score.mjs), with every
// candidate's content, its identity (candidateIdOf: the case, the scanner
// and rule, the file, the lines and the message, which the review queue and
// the rulings key on) and what the scorer made of it. `loaded` is a run as
// score.mjs loadRun reads it, a scanner-only run or a review run. Each
// sample carries the version of its case's spec (specHashOf) it was scored
// against.
export function scanSide({ loaded, runId = null }) {
  const m = loaded.manifest;
  const s = scoreScanAttempts({ manifest: m, attempts: loaded.attempts, specs: loaded.specs });
  const first = new Map(loaded.attempts.filter((a) => a.attempt === 1).map((a) => [`${a.case}\0${a.config}\0${a.repeat}`, a]));
  const samples = s.jobs.map((j) => {
    const raw = first.get(`${j.case}\0${j.config}\0${j.repeat}`)?.scan?.candidates ?? [];
    const specHash = specHashOf(loaded.specs[j.case]);
    return {
      key: `${j.caseId}\0${j.config}\0${j.repeat}`,
      caseId: j.caseId,
      case: j.case,
      config: j.config,
      repeat: j.repeat,
      specHash,
      clean: j.clean,
      status: j.status,
      scanMs: j.scanMs,
      job: j,
      candidates: j.candidates.map((c) => ({ content: contentOf(raw[c.index]), candidateId: c.candidateId, caseId: j.caseId, specHash, token: c.token, file: c.file, lines: [c.line, c.end], message: raw[c.index]?.message ?? "", outcome: c.outcome, evidenceKind: c.evidenceKind, truthId: c.bug ?? null })),
    };
  });
  return { runId: runId ?? m.runId ?? basename(loaded.folder), suite: s.suite, split: m.split ?? "dev", splitHash: m.splitHash ?? null, mode: m.mode ?? "review", rules: { version: SCAN_RULES.version, hash: SCAN_RULES.hash }, samples };
}

const countBy = (list) => {
  const out = new Map();
  for (const c of list) out.set(c.content, (out.get(c.content) ?? 0) + 1);
  return out;
};

// What a scanner change did to every sample's candidates: those of the
// parent it no longer holds (removed) and those it holds beyond the
// parent's (added), as a multiset by content (failure 14), each with its
// sample. `problems` says why the sides cannot be compared (failure 13);
// with problems, nothing else is read.
export function candidateChanges(base, cand) {
  const problems = [];
  for (const [label, s] of [["parent", base], ["candidate", cand]]) if (s.split === "test") problems.push(`the ${label} ${s.runId} is from the test split: the scanner loop never reads a held-out run (PLAN 4.10)`);
  if (base.suite !== cand.suite) problems.push(`the suites differ: ${base.suite} then ${cand.suite}`);
  if (base.splitHash !== cand.splitHash) problems.push(`the split hashes differ: ${base.splitHash} then ${cand.splitHash}`);
  const a = new Map(base.samples.map((s) => [s.key, s]));
  const b = new Map(cand.samples.map((s) => [s.key, s]));
  const only = (x, y) => [...x.values()].filter((s) => !y.has(s.key)).map((s) => `${s.case} ${s.config} ${s.repeat}`);
  if (only(a, b).length > 0 || only(b, a).length > 0) problems.push(`the samples differ: ${only(a, b).length} only in ${base.runId} (${only(a, b).slice(0, 3).join(", ")}), ${only(b, a).length} only in ${cand.runId} (${only(b, a).slice(0, 3).join(", ")})`);
  for (const [side, map] of [[base, a], [cand, b]]) for (const s of map.values()) if (s.status !== "complete") problems.push(`${side.runId} ${s.case} ${s.config} ${s.repeat} saved no scan (${s.status}), so what it would have raised is unknown`);
  // Failure 16: one truth for both sides.
  const differ = [...new Set([...a.values()].filter((s) => b.has(s.key) && b.get(s.key).specHash !== s.specHash).map((s) => s.case))];
  for (const name of differ) problems.push(`the runs score ${name} against different versions of its spec; score both against one (--specs)`);
  if (problems.length > 0) return { problems, removed: [], added: [] };
  const removed = [];
  const added = [];
  for (const [key, sa] of a) {
    const sb = b.get(key);
    const left = countBy(sb.candidates);
    for (const c of sa.candidates) {
      const n = left.get(c.content) ?? 0;
      if (n > 0) left.set(c.content, n - 1);
      else removed.push({ sample: key, ...c });
    }
    const had = countBy(sa.candidates);
    for (const c of sb.candidates) {
      const n = had.get(c.content) ?? 0;
      if (n > 0) had.set(c.content, n - 1);
      else added.push({ sample: key, ...c });
    }
  }
  return { problems: [], removed, added };
}

// What one side holds per case, summed over its samples: issue recall (all,
// and critical plus major), the candidates precision counts (a duplicate
// set apart, as the scan scorer sets it) as correct, unresolved or wrong
// under the rulings on the spec version each sample was scored against
// (failures 15 and 16; `rulings` as readRulings gives them), candidates on
// a clean control, redundant candidates (those the scorer counts as
// redundancy), and all candidates. A Map by case id.
export function scanCaseTotals(side, rulings = { lines: [], people: [] }) {
  const plus = (x, y) => ({ hit: x.hit + y.hit, of: x.of + y.of });
  const out = new Map();
  for (const s of side.samples) {
    const t = out.get(s.caseId) ?? { recall: { hit: 0, of: 0 }, criticalMajor: { hit: 0, of: 0 }, correct: 0, unresolved: 0, counted: 0, clean: 0, redundant: 0, candidates: 0 };
    t.recall = plus(t.recall, s.job.issueRecall.all);
    t.criticalMajor = plus(t.criticalMajor, s.job.issueRecall.criticalMajor);
    for (const c of s.candidates) {
      if (SCAN_PRECISION.apart.includes(c.outcome)) continue;
      t.counted++;
      if (SCAN_PRECISION.correct.includes(c.outcome)) t.correct++;
      else if (SCAN_PRECISION.unresolved.includes(c.outcome)) {
        const r = candidateRuling(c.candidateId, c.specHash, rulings);
        if (r.status === "true" || r.status === "same-issue") t.correct++;
        else if (r.status !== "false") t.unresolved++;
      }
    }
    if (s.clean) t.clean += s.candidates.length;
    t.redundant += s.job.redundancy.hit;
    t.candidates += s.candidates.length;
    out.set(s.caseId, t);
  }
  return out;
}

// The median of a side's scan times (scan_ms per sample), or null when a
// sample did not record one.
export function scanMsP50(side) {
  const xs = side.samples.map((s) => s.scanMs);
  if (xs.length === 0 || xs.some((x) => typeof x !== "number" || !Number.isFinite(x))) return null;
  const v = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ---------------------------------------------------------------------------
// The command.

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const show = (metric, x) => (metric.unit === "count" ? x.toFixed(2) : metric.name === "costPerReview" ? `$${x.toFixed(3)}` : metric.name === "secondsPerReview" ? `${x.toFixed(1)} s` : pct(x));
const showDelta = (metric, x) => { const sign = x < 0 ? "-" : "+"; const a = Math.abs(x); return metric.unit === "points" ? `${sign}${(a * 100).toFixed(1)} points` : metric.name === "costPerReview" ? `${sign}$${a.toFixed(3)}` : metric.name === "secondsPerReview" ? `${sign}${a.toFixed(1)} s` : `${sign}${a.toFixed(2)}`; };

export function renderComparison({ cells }, { alpha }) {
  const out = [];
  for (const cell of cells) {
    out.push(`${cell.path} path, ${cell.reviewer}: ${cell.pairs.map((p) => `${p.parent.runId} ${p.parent.config} (repeats ${p.parent.repeats.join(",")}) against ${p.candidate.runId} ${p.candidate.config} (repeats ${p.candidate.repeats.join(",")})`).join("; ")}`);
    for (const stratum of ["planted", "real", "pooled"]) {
      const s = cell.strata[stratum];
      if (s === null || (stratum === "pooled" && (s === cell.strata.planted || s === cell.strata.real))) continue;
      out.push("");
      out.push(`${stratum} stratum (one-sided alpha ${alpha.toPrecision(3)} per bound):`);
      out.push("");
      out.push("| Metric | Parent | Candidate | Change | Bounds | Changed clusters | Verdict |");
      out.push("|---|---|---|---|---|---|---|");
      for (const m of METRICS) {
        const r = s.metrics[m.name];
        if (!r) continue;
        const like = r.like?.lower ?? r;
        const v = changeVerdict(r, alpha);
        const bounds = r.like ? `lower ${showDelta(m, r.like.lower.delta)} [${showDelta(m, r.like.lower.lo)}, ${showDelta(m, r.like.lower.hi)}]; upper ${showDelta(m, r.like.upper.delta)}; worse for the change ${showDelta(m, r.delta)}` : `[${showDelta(m, r.lo)}, ${showDelta(m, r.hi)}]`;
        out.push(`| ${m.label}${m.gate ? "" : " (reported)"} | ${r.measured ? show(m, like.parent) : "n/a"} | ${r.measured ? show(m, like.candidate) : "n/a"} | ${r.measured ? showDelta(m, like.delta) : "n/a"} | ${r.measured ? bounds : "n/a"} | ${like.changed} of ${like.clusters}${like.method ? `, ${like.method}` : ""} | ${v} |`);
      }
    }
    out.push("");
    if (cell.hard.broken.length > 0) out.push(`Hard rules broken:\n${cell.hard.broken.map((h) => `- ${h}`).join("\n")}`);
    if (cell.hard.unresolved.length > 0) out.push(`Hard rules open until a person rules:\n${cell.hard.unresolved.map((h) => `- ${h}`).join("\n")}`);
    if (cell.hard.broken.length === 0 && cell.hard.unresolved.length === 0) out.push("No hard rule broken.");
    out.push("");
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const o = { parent: null, candidate: null, parentConfig: null, candidateConfig: null, parentRepeats: null, candidateRepeats: null, parentSpecs: null, candidateSpecs: null, alpha: 0.05, decisions: decisionsPath, json: false };
  const value = (i) => {
    if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  const repeatsOf = (s) => {
    const list = s.split(",").map(Number);
    if (!list.every((n) => Number.isInteger(n) && n >= 1)) throw new Error(`repeats are numbers from 1, comma separated: ${s}`);
    return list;
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--config") o.parentConfig = o.candidateConfig = value(i++);
    else if (a === "--parent-config") o.parentConfig = value(i++);
    else if (a === "--candidate-config") o.candidateConfig = value(i++);
    else if (a === "--parent-repeats") o.parentRepeats = repeatsOf(value(i++));
    else if (a === "--candidate-repeats") o.candidateRepeats = repeatsOf(value(i++));
    else if (a === "--specs") o.parentSpecs = o.candidateSpecs = value(i++);
    else if (a === "--parent-specs") o.parentSpecs = value(i++);
    else if (a === "--candidate-specs") o.candidateSpecs = value(i++);
    else if (a === "--decisions") o.decisions = value(i++);
    else if (a === "--alpha") {
      o.alpha = Number(value(i++));
      if (!(o.alpha > 0 && o.alpha < 1)) throw new Error("--alpha must be a number between 0 and 1");
    } else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Error("name two runs: the parent, then the candidate");
  [o.parent, o.candidate] = positional;
  return o;
}

// The pairs two runs give: the named configurations, or every one both hold.
export function pairsOf(parentSides, candidateSides, { parentConfig = null, candidateConfig = null } = {}) {
  if (parentConfig !== null || candidateConfig !== null) {
    const p = parentSides.find((s) => s.config === (parentConfig ?? candidateConfig));
    const c = candidateSides.find((s) => s.config === (candidateConfig ?? parentConfig));
    if (!p || !c) throw new Error(`the configuration ${!p ? parentConfig ?? candidateConfig : candidateConfig ?? parentConfig} is not in the ${!p ? "parent" : "candidate"} run (it has ${(!p ? parentSides : candidateSides).map((s) => s.config).join(", ")})`);
    return [{ parent: p, candidate: c }];
  }
  const pairs = parentSides.filter((p) => candidateSides.some((c) => c.config === p.config)).map((p) => ({ parent: p, candidate: candidateSides.find((c) => c.config === p.config) }));
  if (pairs.length === 0) throw new Error("the two runs share no configuration; name them with --parent-config and --candidate-config");
  return pairs;
}

function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
    const decisions = readRulings(resolve(o.decisions));
    const parentSides = loadSides({ run: o.parent, specs: o.parentSpecs, repeats: o.parentRepeats, decisions });
    const candidateSides = loadSides({ run: o.candidate, specs: o.candidateSpecs, repeats: o.candidateRepeats, decisions });
    const pairs = pairsOf(parentSides, candidateSides, o);
    // The family error over the gate metrics, both directions.
    const alpha = o.alpha / (2 * GATE_METRICS.length);
    const result = comparePairs(pairs, { alpha, seed: `${parentSides[0].runId}|${candidateSides[0].runId}` });
    if (result.problems.length > 0) {
      console.error(`refused: these runs cannot be paired:\n${result.problems.map((p) => `- ${p}`).join("\n")}`);
      process.exit(2);
    }
    if (o.json) console.log(JSON.stringify({ alpha, family: o.alpha, ...result }, null, 2));
    else {
      console.log(`Paired comparison, candidate minus parent, by the sign-flip test over clusters (a case on planted suites, a repository group on real ones, every repeat inside it). The verdict reads lower against lower and upper against upper at one-sided alpha ${alpha.toPrecision(3)} per metric and direction (${o.alpha} over ${GATE_METRICS.length} gate metrics, both directions), halved across the two bounds when they differ; the acceptance rule reads the bound worse for the change.\n`);
      console.log(renderComparison(result, { alpha }));
    }
    process.exit(0);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
