// Intervals and paired comparisons for the benchmark's ratios. Used by
// score.mjs (each run's interval, a cluster bootstrap shown beside its
// numbers), trend.mjs (the regression alarm) and the reviewer loop's paired
// comparison (P3-04 passes its own seed and alpha). The alarm and the
// acceptance bounds come from a paired sign-flip test, never the bootstrap.
//
// A cluster is the unit that is drawn or flipped: the case on planted
// suites, the repository group on real ones. All of a cluster's truth items,
// findings and repeats travel together, because reviews of one case share
// its code and its brief and are not independent trials. Every metric is a
// ratio of sums ({hit, of}: hits over checks, or dollars over reviews),
// recomputed from the clusters on each draw, never an average of per-case
// ratios.
//
// Why the paired comparison is a sign-flip test at every size. When k of n
// clusters change, all the same way, and the rest stay put, a paired
// bootstrap reads "no change" only on a resample that draws none of the k,
// which happens with probability (1 - k/n)^n, below e^-k at every n. The
// exact paired test (under no change, either run's result of a cluster is
// as likely to be the other's, so each of the 2^k swaps of the changed
// clusters is equally likely) gives 2^-k. Since e^-k < 2^-k for every k,
// the bootstrap calls a drop significant at alpha whenever ln(1/alpha) < k
// < log2(1/alpha), however many clusters there are: at the alarm's 0.0125,
// five or six cases moving one way, whether among 8, 100 or 1,000 (four of
// eight: 0.39 percent against an exact 6.25; five of a hundred: 0.59
// against 3.1). No cluster count can be the threshold, so pairedBounds runs
// the sign-flip test itself: every swap when at most EXACT_MAX clusters
// changed, a seeded sample of swaps beyond.
//
// A run's own interval stays a percentile bootstrap. It describes the run
// and decides nothing. It is shown from MIN_CLUSTERS = 8 clusters, above
// the 7 at which the exact paired test can reach the alarm's level at all
// (2^-7 < 0.0125 < 2^-6), so no interval is shown on clusters too few for
// any decision; below, the score says "too few clusters".
//
// Failure list, written before the code:
// 1. Two scorings of one run give different intervals: nothing here reads a
//    clock, Math.random or a path. The draws come from mulberry32 seeded
//    with the first 32 bits of a sha256 the caller names (seedOf), clusters
//    are sorted by key before drawing, and the bounds are order statistics
//    picked by integer arithmetic.
// 2. Three repeats of one bug count as three independent trials: the caller
//    hands in per-case sums over every repeat, and only clusters are drawn,
//    so three reviews that agree add no width-narrowing evidence.
// 3. A cluster with nothing to count (a clean case for recall, a case with
//    no finding for precision) is drawn like one with evidence, so the
//    count of clusters behind an interval is overstated: such a cluster is
//    left out of that metric.
// 4. An interval is printed for a handful of clusters, where the bootstrap
//    is meaningless: below MIN_CLUSTERS the interval is null.
// 5. A percentile is picked with floating arithmetic, so 95% lands one order
//    statistic off on some resample counts: the index is computed with a
//    tolerance, from alpha and the count.
// 6. A paired comparison treats the two runs as independent, so the noise
//    they share inflates the difference's spread: the test swaps the two
//    runs' results within a cluster, never across clusters.
// 7. A drop carried by a few clusters is called significant because the
//    bootstrap rarely draws a resample without them (the reasoning above):
//    the paired comparison is the sign-flip test, exact up to EXACT_MAX
//    changed clusters, and its bounds can pass zero only where the test
//    rejects no change.
import { createHash } from "node:crypto";

export const RESAMPLES = 10_000;
export const LEVEL = 0.95;
export const MIN_CLUSTERS = 8;
// Up to 16 changed clusters every one of the 2^16 = 65,536 swaps is tried,
// about six times the sampled draws; beyond, RESAMPLES seeded swaps are.
export const EXACT_MAX = 16;

// A 32-bit seed from named parts: the first four bytes of sha256 over the
// parts joined by NUL.
export function seedOf(...parts) {
  return createHash("sha256").update(parts.map(String).join("\0")).digest().readUInt32BE(0);
}

// The mulberry32 generator: a seed in, a function giving numbers in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const plus = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });
// A ratio of sums; no checks reads as 1, as lib/score.mjs value() does.
const ratioOf = (hit, of) => (of === 0 ? 1 : hit / of);

// Per-case ratios ({ <caseId>: {hit, of} }) summed into clusters, sorted by
// cluster key. `clusterOf(caseId)` names a case's cluster; by default the
// case is its own.
export function clusterSums(perCase, clusterOf = (id) => id) {
  const out = new Map();
  for (const [id, r] of Object.entries(perCase)) {
    const key = clusterOf(id);
    out.set(key, plus(out.get(key) ?? { hit: 0, of: 0 }, r));
  }
  return [...out].map(([key, r]) => ({ key, ...r })).sort(byKey);
}

// Two runs' per-case ratios paired by cluster, over the case ids both hold:
// [{ key, a: {hit, of}, b: {hit, of} }], sorted by key.
export function pairedSums(a, b, clusterOf = (id) => id) {
  const out = new Map();
  for (const id of Object.keys(a)) {
    if (b[id] === undefined) continue;
    const key = clusterOf(id);
    const x = out.get(key) ?? { a: { hit: 0, of: 0 }, b: { hit: 0, of: 0 } };
    out.set(key, { a: plus(x.a, a[id]), b: plus(x.b, b[id]) });
  }
  return [...out].map(([key, x]) => ({ key, ...x })).sort(byKey);
}

// The k-th smallest of `resamples` sorted values that a one-sided bound at
// `alpha` reads, as a 0-based index from each end (failure 5).
const tail = (alpha, resamples) => Math.max(0, Math.ceil(alpha * resamples - 1e-9) - 1);

// Draws `resamples` resamples of n clusters with replacement and returns
// the statistic of each, sorted. `stat(picks)` reads the drawn indices.
function draw(n, { seed, resamples }, stat) {
  const rand = mulberry32(seed);
  const picks = new Int32Array(n);
  const out = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < n; i++) picks[i] = Math.floor(rand() * n);
    out[r] = stat(picks);
  }
  return out.sort();
}

// One run's two-sided percentile interval of a ratio of sums at `level`:
// { ci: [lo, hi] | null, clusters } where clusters counts those with
// something to count. `clusters` comes from clusterSums.
export function clusterInterval({ clusters, seed, level = LEVEL, resamples = RESAMPLES, minClusters = MIN_CLUSTERS }) {
  const used = clusters.filter((c) => c.of > 0);
  if (used.length < minClusters) return { ci: null, clusters: used.length };
  const sorted = draw(used.length, { seed, resamples }, (picks) => {
    let hit = 0;
    let of = 0;
    for (const i of picks) {
      hit += used[i].hit;
      of += used[i].of;
    }
    return ratioOf(hit, of);
  });
  const k = tail((1 - level) / 2, resamples);
  return { ci: [sorted[k], sorted[resamples - 1 - k]], clusters: used.length };
}

// The change b minus a of a ratio of sums under every swap of the changed
// clusters' two results, the observed one first. Swaps are visited in Gray
// code order, so each differs from the one before by one cluster.
function everySwap(total, changed) {
  const out = new Float64Array(2 ** changed.length);
  let { hit: ah, of: ao } = total.a;
  let { hit: bh, of: bo } = total.b;
  const swapped = new Uint8Array(changed.length);
  out[0] = ratioOf(bh, bo) - ratioOf(ah, ao);
  for (let t = 1; t < out.length; t++) {
    const j = 31 - Math.clz32(t & -t);
    const p = changed[j];
    const way = swapped[j] === 0 ? 1 : -1;
    const dh = (p.b.hit - p.a.hit) * way;
    const dof = (p.b.of - p.a.of) * way;
    ah += dh;
    ao += dof;
    bh -= dh;
    bo -= dof;
    swapped[j] ^= 1;
    out[t] = ratioOf(bh, bo) - ratioOf(ah, ao);
  }
  return out;
}

// The same, over the observed swap and `resamples` seeded random swaps,
// each changed cluster swapped with probability one half.
function someSwaps(total, changed, { seed, resamples }) {
  const rand = mulberry32(seed);
  const out = new Float64Array(resamples + 1);
  out[0] = ratioOf(total.b.hit, total.b.of) - ratioOf(total.a.hit, total.a.of);
  for (let r = 1; r <= resamples; r++) {
    let { hit: ah, of: ao } = total.a;
    let { hit: bh, of: bo } = total.b;
    for (const p of changed) {
      if (rand() >= 0.5) continue;
      ah += p.b.hit - p.a.hit;
      ao += p.b.of - p.a.of;
      bh -= p.b.hit - p.a.hit;
      bo -= p.b.of - p.a.of;
    }
    out[r] = ratioOf(bh, bo) - ratioOf(ah, ao);
  }
  return out;
}

// The paired change b minus a of a ratio of sums, by the sign-flip test
// (failure 7): { delta, lower, upper, pLower, pUpper, clusters, changed,
// method }. pLower is the chance, with no real change, of a change as low
// as delta or lower, pUpper as high or higher; under no change either run's
// result of a cluster is as likely to be the other's. `upper` is the
// one-sided bound at `alpha` above which the change is unlikely: below zero
// exactly when pLower <= alpha; `lower` the same from below (above zero
// exactly when pUpper <= alpha). The bounds shift the no-change spread to
// delta; that is exact at zero, which the alarm and the primary metric
// test, and close elsewhere, which a guard's loss tests. `method` is
// "exact" (every swap) or "sampled" (the observed swap and `resamples`
// seeded ones, counted as the p-values' denominator). `pairs` comes from
// pairedSums; a cluster whose two results are equal is never swapped.
export function pairedBounds({ pairs, seed, alpha, resamples = RESAMPLES }) {
  const used = pairs.filter((p) => p.a.of > 0 || p.b.of > 0);
  const total = used.reduce((t, p) => ({ a: plus(t.a, p.a), b: plus(t.b, p.b) }), { a: { hit: 0, of: 0 }, b: { hit: 0, of: 0 } });
  const changed = used.filter((p) => p.a.hit !== p.b.hit || p.a.of !== p.b.of);
  const exact = changed.length <= EXACT_MAX;
  const values = exact ? everySwap(total, changed) : someSwaps(total, changed, { seed, resamples });
  const delta = values[0];
  let atOrBelow = 0;
  let atOrAbove = 0;
  for (const v of values) {
    if (v <= delta) atOrBelow++;
    if (v >= delta) atOrAbove++;
  }
  const n = values.length;
  values.sort();
  // The largest count of swaps at or below delta at which the test still
  // rejects no change is floor(alpha n); the next order statistic is the
  // edge of the no-change spread.
  const k = Math.floor(alpha * n + 1e-9);
  const upper = k < n ? delta - values[k] : Number.POSITIVE_INFINITY;
  const lower = k < n ? delta - values[n - 1 - k] : Number.NEGATIVE_INFINITY;
  return { delta, lower, upper, pLower: atOrBelow / n, pUpper: atOrAbove / n, clusters: used.length, changed: changed.length, method: exact ? "exact" : "sampled" };
}

// ---------------------------------------------------------------------------
// The intervals a score carries, and the metrics the trend's alarm reads.

// The issue-level ratios that get an interval in score.json and the index,
// and that the trend compares: where each sits in a per-case entry and in a
// configuration's headline. Higher is better for every one. Location
// metrics are diagnostics and are not here.
export const ISSUE_METRICS = [
  { name: "issueRecall.all", label: "issue recall", perCase: (c) => c.issueRecall, headline: (h) => h.issueRecall.all },
  { name: "issueRecall.criticalMajor", label: "critical and major issue recall", perCase: (c) => c.criticalMajor, headline: (h) => h.issueRecall.criticalMajor },
  { name: "precision.lower", label: "precision, lower bound", perCase: (c) => c.precision.lower, headline: (h) => h.precision.lower },
  { name: "precision.upper", label: "precision, upper bound", perCase: (c) => c.precision.upper, headline: (h) => h.precision.upper },
];

export const INTERVAL_METHOD = "Percentile bootstrap over clusters drawn with replacement; each metric is a ratio of sums recomputed on every resample, and a cluster keeps all its truth items, findings and repeats together. A cluster with nothing to count for a metric is left out of it. The interval describes this run and decides nothing: the trend's alarm and the acceptance rule compare two runs with a paired sign-flip test. With fewer than minClusters clusters it is null, listed under tooFewClusters.";
export const SEED_RULE = "mulberry32 seeded with the first 32 bits of sha256 over the run id, the configuration and the metric name, joined by NUL";

// The cluster of each case: the case itself on a planted suite, its
// repository group on a real one. `groups` maps case id to group, or is null.
export const clusterFn = (groups) => (groups === null ? (id) => id : (id) => groups[id]);

// A score's intervals: `byConfig` with `ci` added to each ISSUE_METRICS
// ratio, and the `intervals` block that says how they were drawn. `perCase`
// is { <config>: { <caseId>: per-case sums } }, `groups` as in clusterFn.
export function runIntervals({ runId, byConfig, perCase, groups, resamples = RESAMPLES }) {
  const out = structuredClone(byConfig);
  const tooFew = {};
  const clusterOf = clusterFn(groups);
  for (const config of Object.keys(out).sort()) {
    for (const m of ISSUE_METRICS) {
      const cases = Object.fromEntries(Object.entries(perCase[config] ?? {}).map(([id, c]) => [id, m.perCase(c)]));
      const { ci, clusters } = clusterInterval({ clusters: clusterSums(cases, clusterOf), seed: seedOf(runId, config, m.name), resamples });
      m.headline(out[config]).ci = ci;
      if (ci === null) (tooFew[config] ??= {})[m.name] = clusters;
    }
  }
  const intervals = { method: INTERVAL_METHOD, cluster: groups === null ? "case" : "repoGroup", groups, resamples, level: LEVEL, minClusters: MIN_CLUSTERS, seed: SEED_RULE, runId, tooFewClusters: tooFew };
  return { byConfig: out, intervals };
}
