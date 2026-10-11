// Intervals for the benchmark's ratios, by cluster bootstrap. Used by
// score.mjs (each run's intervals), trend.mjs (the regression alarm) and the
// reviewer loop's paired comparison (P3-04 passes its own seed and alpha).
//
// A cluster is the unit that is resampled: the case on planted suites, the
// repository group on real ones. All of a cluster's truth items, findings
// and repeats travel together, because reviews of one case share its code
// and its brief and are not independent trials. Every metric is a ratio of
// sums ({hit, of}: hits over checks, or dollars over reviews), recomputed
// from the drawn clusters on each resample, never an average of per-case
// ratios.
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
// 6. A paired comparison resamples the two runs independently, so the noise
//    the runs share inflates the difference's spread: one draw of cluster
//    indices serves both sides of every resample.
import { createHash } from "node:crypto";

export const RESAMPLES = 10_000;
export const LEVEL = 0.95;
export const MIN_CLUSTERS = 8;

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

// The paired difference b minus a of a ratio of sums, with one-sided bounds
// at `alpha`: { delta, lower, upper, clusters }. `lower` is the alpha
// quantile of the resampled differences (b is better than a by more than it
// with probability 1 - alpha), `upper` the 1 - alpha quantile. Both are null
// below `minClusters` clusters with something to count on either side.
// `pairs` comes from pairedSums; the same draw serves both sides.
export function pairedBounds({ pairs, seed, alpha, resamples = RESAMPLES, minClusters = MIN_CLUSTERS }) {
  const used = pairs.filter((p) => p.a.of > 0 || p.b.of > 0);
  const total = used.reduce((t, p) => ({ a: plus(t.a, p.a), b: plus(t.b, p.b) }), { a: { hit: 0, of: 0 }, b: { hit: 0, of: 0 } });
  const delta = ratioOf(total.b.hit, total.b.of) - ratioOf(total.a.hit, total.a.of);
  if (used.length < minClusters) return { delta, lower: null, upper: null, clusters: used.length };
  const sorted = draw(used.length, { seed, resamples }, (picks) => {
    let ah = 0;
    let ao = 0;
    let bh = 0;
    let bo = 0;
    for (const i of picks) {
      ah += used[i].a.hit;
      ao += used[i].a.of;
      bh += used[i].b.hit;
      bo += used[i].b.of;
    }
    return ratioOf(bh, bo) - ratioOf(ah, ao);
  });
  const k = tail(alpha, resamples);
  return { delta, lower: sorted[k], upper: sorted[resamples - 1 - k], clusters: used.length };
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

export const INTERVAL_METHOD = "Percentile bootstrap over clusters drawn with replacement; each metric is a ratio of sums recomputed on every resample, and a cluster keeps all its truth items, findings and repeats together. A cluster with nothing to count for a metric is left out of it.";
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
