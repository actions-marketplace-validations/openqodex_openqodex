// Scores saved reviews against the planted bugs of their case specs.
// Nothing here starts a reviewer or reads anything but saved files.
//
// The vocabulary is the graph corpus's (packages/graph/corpus/score.ts): a
// score is a Ratio { hit, of }, `value` reads no checks as 1, and the names
// are the same where the meaning is the same: precision, recall, gaps,
// controls, failures.
//
// A finding matches a planted bug only when three things hold: its place
// (same file, line ranges that overlap), its kind (a category the bug lists)
// and its words (the finding's text names one of the bug's `mentions` at the
// start of a word; case does not matter). Every plant and every accepted side
// issue lists `mentions`; one without them can never be matched. The checks
// run in this order, and the first that holds decides:
//   1. test-only   a finding of kind maintainability or style whose title
//                  asks for a test ("has no covering test", "lacks tests",
//                  "untested"). On a planted case it is true and not
//                  planted (the planted cases ship no tests by design), so it
//                  is counted apart, as test-gap, and left out of precision.
//                  On a clean case, which ships its tests, it is false.
//   2. accepted    a side issue the spec lists in `extras` (real, not
//                  planted), matched by place and words (and kind, when the
//                  extra lists kinds): left out of precision
//   3. hit         a planted bug, matched by place, kind and words. A second
//                  hit on a bug already hit in the same review is a
//                  duplicate: reported apart, never counted in precision.
//   4. near        a hit in every way but the lines: within NEAR_LINES lines
//      wrong-kind  of the range, not on it; or a hit in every way but the
//                  kind. Neither is a hit; both count against precision.
//   5. false       anything else; on a clean case every finding is false.
// A bug's `also` locations count as its own. When a finding is a hit for two
// bugs, the bug whose anchor line is nearest wins, then the first.
//
// Failure list, written before the code:
// 1. A finding one line off counts as found, or silently as false: it is a
//    near miss, listed with its distance, and not a hit.
// 2. A finding on the right line about something else counts as found: it
//    must name the issue (its words) and be of a planted kind; a wrong kind
//    is a wrong-kind, other words are false.
// 3. One finding is counted for two bugs whose ranges overlap: each finding
//    goes to one bug at most, by the order above.
// 4. Two findings for one bug count as two bugs found, or raise precision:
//    recall counts bugs; the second finding is a duplicate, left out of
//    precision and reported apart.
// 5. A real issue the spec did not plant counts as false although the spec
//    lists it: extras are matched first and left out of precision.
// 6. A request for a test is scored as a wrong kind or a near miss of the
//    plant whose lines it spans: requests for tests are checked first.
// 7. A clean case scores well because it has nothing to miss: every finding
//    there is false, and its control passes only when the review completed
//    with no finding; an incomplete or missing review fails it.
// 8. A missing or incomplete report is left out, so a crash looks perfect:
//    a missing report misses every bug and is counted as failed; an
//    incomplete one is scored on what it holds and counted as incomplete.
// 9. Gap disclosure is read from data the reviewer never saw: it is read
//    from the saved brief, the text the reviewer was given.
// 10. A run with the graph off gets credit for gaps its brief never named:
//    gaps are counted from the brief's text only, so graph off scores 0.
// 11. A spec edited after a run changes that run's score: the scorer takes
//    the specs the run copied into its own folder, unless told otherwise,
//    and then says so.
// 12. Paths written differently (./a.py, a\b.py) do not match: both sides
//    are normalised.
// 13. Averages of averages over different sample counts mislead: ratios are
//    summed hits over summed checks; times and costs carry their count.
// 14. Two runs with different models, reviewers, machines or settings read
//    as a product change: the comparison names every such difference above
//    its table.
// Score format 3 adds its own failure list, below the format 2 code.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCaseId } from "./cases.mjs";

export const NEAR_LINES = 3;
export const SEVERITY_ORDER = ["critical", "major", "minor", "nitpick", "info"];

export const ratio = () => ({ hit: 0, of: 0 });
export const value = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const add = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

export const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findingText(f) {
  return [f.title, f.problem, f.consequence, f.fix, f.description, f.suggested_change].filter((x) => typeof x === "string").join("\n").toLowerCase();
}

function locations(bug) {
  return [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])].map((l) => ({ file: normPath(l.file), lines: l.lines }));
}

// Lines between a finding's range and a location's range: 0 when they overlap.
function gap(start, end, lines) {
  if (end < lines[0]) return lines[0] - end;
  if (start > lines[1]) return start - lines[1];
  return 0;
}

// Whether the text names one of the words, each at the start of a word.
// No words, no match: a plant without its words can never be found.
export function names(words, text) {
  if (!Array.isArray(words) || words.length === 0) return false;
  return words.some((w) => new RegExp(`(^|[^a-z0-9])${escape(w.toLowerCase())}`).test(text));
}

// A title that asks for a test, and the kinds such a request comes in.
export const TEST_ONLY = /\b(no|missing|lacks?|lacking|without|needs?|add)\b[^.]{0,60}\btests?\b|\buntested\b|\btest coverage\b|\bnot covered by (any |a )?tests?\b/i;
export const TEST_ONLY_KINDS = ["maintainability", "style"];

// The outcome of one finding against a spec. Duplicates are decided per
// review (scoreSample), since they depend on the other findings. The
// test-only rule holds for planted cases, which ship no tests by design;
// `testOnly: false` (a real pull request) skips it.
export function classify(finding, spec, { testOnly = true } = {}) {
  const file = normPath(finding.file_path);
  const start = finding.line_number;
  const end = Math.max(finding.line_end ?? start, start);
  const text = findingText(finding);
  const bugs = spec.bugs ?? [];

  if (testOnly && TEST_ONLY_KINDS.includes(finding.category) && TEST_ONLY.test(String(finding.title ?? ""))) {
    return spec.clean ? { outcome: "false", testOnly: true } : { outcome: "test-gap" };
  }

  const extras = spec.extras ?? [];
  const at = extras.findIndex((x) => normPath(x.file) === file && gap(start, end, x.lines) === 0 && names(x.mentions, text) && (!x.kind || x.kind.includes(finding.category)));
  if (at !== -1) return { outcome: "accepted", why: extras[at].why, extra: at };

  const dist = (bug) => {
    const ds = locations(bug).filter((l) => l.file === file).map((l) => gap(start, end, l.lines));
    return ds.length === 0 ? null : Math.min(...ds);
  };
  const kindOk = (bug) => bug.kind.includes(finding.category);
  const said = (bug) => names(bug.mentions, text);
  const hits = bugs
    .map((bug, order) => ({ bug, order, d: dist(bug) }))
    .filter(({ bug, d }) => d === 0 && kindOk(bug) && said(bug));
  if (hits.length > 0) {
    const anchorGap = (bug) => (normPath(bug.file) === file ? Math.abs(start - bug.anchor.line) : 0);
    hits.sort((a, b) => anchorGap(a.bug) - anchorGap(b.bug) || a.order - b.order);
    return { outcome: "hit", bug: hits[0].bug.id };
  }

  const near = bugs
    .map((bug) => ({ bug, d: dist(bug) }))
    .filter(({ bug, d }) => d !== null && d > 0 && d <= NEAR_LINES && kindOk(bug) && said(bug))
    .sort((a, b) => a.d - b.d)[0];
  const wrong = bugs.find((bug) => dist(bug) === 0 && said(bug) && !kindOk(bug));
  if (wrong) return { outcome: "wrong-kind", bug: wrong.id, expected: wrong.kind };
  if (near) return { outcome: "near", bug: near.bug.id, distance: near.d };
  return { outcome: "false" };
}

// Outcomes left out of precision.
const UNCOUNTED = new Set(["accepted", "test-gap", "duplicate"]);


// The part of the brief the code graph wrote, or null when the graph did
// not run (its block then starts with a line saying so).
export function graphBlock(brief) {
  if (typeof brief !== "string") return null;
  const at = brief.indexOf("## What this change reaches");
  if (at === -1) return null;
  const next = brief.indexOf("\n## ", at + 5);
  const block = brief.slice(at, next === -1 ? undefined : next);
  return /The code graph (is off|was skipped|could not be built)/.test(block) ? null : block;
}

// What the brief told the reviewer: each expected gap site with its cause,
// each expected floor, each expected caller site.
export function scoreBrief(spec, brief) {
  const g = spec.graph ?? {};
  const block = graphBlock(brief);
  const gaps = ratio();
  const callers = ratio();
  const failures = [];
  const unseen = block === null ? "" : (block.split("What the graph could not see:")[1] ?? "");
  for (const u of g.gaps ?? []) {
    gaps.of++;
    const re = new RegExp(`^\\s*- ${escape(`${u.file}:${u.line}`)}\\b.*: ${escape(u.cause)}\\b`, "m");
    if (re.test(unseen)) gaps.hit++;
    else failures.push(`the brief does not name the ${u.cause} call at ${u.file}:${u.line} as unseen`);
  }
  for (const f of g.floors ?? []) {
    gaps.of++;
    const name = f.slice(f.indexOf("#") + 1);
    if (unseen.includes(`The callers of \`${name}\` are a floor`)) gaps.hit++;
    else failures.push(`the brief does not say the callers of ${name} are a floor`);
  }
  for (const site of g.callers ?? []) {
    callers.of++;
    if (block !== null && new RegExp(`^- ${escape(site)} `, "m").test(block)) callers.hit++;
    else failures.push(`the brief does not list the caller at ${site}`);
  }
  return { graph: block === null ? "off" : "on", gaps, callers, failures };
}

// Every finding the developer is shown: on the change, and outside it.
export function shownFindings(report) {
  if (!report) return [];
  return [...(report.findings ?? []), ...(report.outside_change ?? [])];
}

// One saved review of one case: `report` is report.json (null when the run
// wrote none), `brief` is brief.md (null when absent), `row` is run.mjs's
// record of the run (time, exit code).
export function scoreSample({ spec, report, brief, row = {}, testOnly = true }) {
  const findings = shownFindings(report).map((f) => ({
    file: normPath(f.file_path),
    line: f.line_number,
    end: f.line_end ?? f.line_number,
    category: f.category,
    severity: f.severity,
    origin: f.origin,
    raised: f.candidate ?? null,
    source: f.source ?? null,
    title: f.title,
    ...classify(f, spec, { testOnly }),
  }));
  // A second hit on a bug already hit in this review is a duplicate.
  const hitBugs = new Set();
  for (const f of findings) {
    if (f.outcome !== "hit") continue;
    if (hitBugs.has(f.bug)) f.outcome = "duplicate";
    else hitBugs.add(f.bug);
  }
  const status = report === null ? "failed" : report.completion?.status === "complete" ? "complete" : "incomplete";
  const recall = ratio();
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, ratio()]));
  const bugs = (spec.bugs ?? []).map((bug) => {
    const mine = findings.filter((f) => f.bug === bug.id);
    const hits = mine.filter((f) => f.outcome === "hit" || f.outcome === "duplicate");
    const found = hits.length > 0;
    recall.of++;
    bySeverity[bug.severity].of++;
    if (found) {
      recall.hit++;
      bySeverity[bug.severity].hit++;
    }
    const dropped = (report?.dropped ?? []).filter((d) => {
      const c = d.candidate ?? {};
      return locations(bug).some((l) => l.file === normPath(c.filePath) && gap(c.lineStart, Math.max(c.lineEnd ?? c.lineStart, c.lineStart), l.lines) === 0);
    });
    return {
      id: bug.id,
      severity: bug.severity,
      found,
      duplicates: mine.filter((f) => f.outcome === "duplicate").length,
      // The severity the reviewer gave the first finding that found it.
      given: found ? hits[0].severity : null,
      // Raised from a scanner candidate, or the reviewer's own.
      via: found ? (hits.some((h) => h.raised !== null) ? "scanner" : "reviewer") : null,
      near: mine.filter((f) => f.outcome === "near").map((f) => f.distance),
      wrongKind: mine.filter((f) => f.outcome === "wrong-kind").map((f) => f.category),
      // Scanner candidates on this bug that the reviewer dropped.
      droppedCandidates: dropped.map((d) => d.candidate?.token ?? "unknown"),
    };
  });
  const precision = ratio();
  for (const f of findings) {
    if (UNCOUNTED.has(f.outcome)) continue;
    precision.of++;
    if (f.outcome === "hit") precision.hit++;
  }
  const counted = findings.filter((f) => !UNCOUNTED.has(f.outcome)).length;
  // A clean change passes only a review that completed with no finding.
  const controls = spec.clean ? { hit: status === "complete" && counted === 0 ? 1 : 0, of: 1 } : ratio();
  const brief_ = scoreBrief(spec, brief);
  const usage = report?.completion?.reviewer?.usage ?? null;
  return {
    case: spec.id,
    config: row.config ?? null,
    repeat: row.repeat ?? null,
    attempt: row.attempt ?? 1,
    status,
    verdict: report?.verdict ?? null,
    exit: row.exit ?? null,
    graph: report?.impact?.status ?? null,
    brief: brief_.graph,
    bugs,
    findings,
    recall,
    bySeverity,
    precision,
    falseFindings: findings.filter((f) => f.outcome === "false").length,
    nearMisses: findings.filter((f) => f.outcome === "near").length,
    wrongKinds: findings.filter((f) => f.outcome === "wrong-kind").length,
    accepted: findings.filter((f) => f.outcome === "accepted").length,
    duplicates: findings.filter((f) => f.outcome === "duplicate").length,
    testGaps: findings.filter((f) => f.outcome === "test-gap").length,
    controls,
    gaps: brief_.gaps,
    callers: brief_.callers,
    failures: brief_.failures,
    wallMs: row.wallMs ?? null,
    reviewerMs: report?.completion?.reviewer?.duration_ms ?? null,
    graphMs: report?.impact?.build?.durationMs ?? null,
    turns: usage?.turns ?? null,
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    costUsd: usage?.cost_usd ?? null,
    rounds: report?.completion?.reviewer?.rounds ?? null,
  };
}

const nums = (xs) => xs.filter((x) => typeof x === "number" && Number.isFinite(x));
export function stats(xs) {
  const v = nums(xs).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, mean: null, median: null, total: null };
  const total = v.reduce((a, b) => a + b, 0);
  const mid = Math.floor(v.length / 2);
  return { n: v.length, mean: total / v.length, median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, total };
}

// Sums a set of sample scores: ratios as hits over checks, times and money
// as means and medians with their count.
export function summarize(samples) {
  const out = {
    samples: samples.length,
    complete: samples.filter((s) => s.status === "complete").length,
    incomplete: samples.filter((s) => s.status === "incomplete").length,
    failed: samples.filter((s) => s.status === "failed").length,
    recall: ratio(),
    bySeverity: Object.fromEntries(SEVERITY_ORDER.map((s) => [s, ratio()])),
    precision: ratio(),
    controls: ratio(),
    gaps: ratio(),
    callers: ratio(),
    falseFindings: 0,
    nearMisses: 0,
    wrongKinds: 0,
    accepted: 0,
    duplicates: 0,
    testGaps: 0,
    wallMs: stats(samples.map((s) => s.wallMs)),
    reviewerMs: stats(samples.map((s) => s.reviewerMs)),
    costUsd: stats(samples.map((s) => s.costUsd)),
    turns: stats(samples.map((s) => s.turns)),
    inputTokens: stats(samples.map((s) => s.inputTokens)),
    outputTokens: stats(samples.map((s) => s.outputTokens)),
  };
  for (const s of samples) {
    out.recall = add(out.recall, s.recall);
    for (const k of SEVERITY_ORDER) out.bySeverity[k] = add(out.bySeverity[k], s.bySeverity[k]);
    out.precision = add(out.precision, s.precision);
    out.controls = add(out.controls, s.controls);
    out.gaps = add(out.gaps, s.gaps);
    out.callers = add(out.callers, s.callers);
    out.falseFindings += s.falseFindings;
    out.nearMisses += s.nearMisses;
    out.wrongKinds += s.wrongKinds;
    out.accepted += s.accepted;
    out.duplicates += s.duplicates;
    out.testGaps += s.testGaps;
  }
  return out;
}

// Per bug across repeats: in how many samples of a config it was found.
export function bugStability(samples) {
  const out = {};
  for (const s of samples) {
    for (const b of s.bugs) {
      const key = `${s.case}/${b.id}`;
      out[key] ??= { case: s.case, bug: b.id, severity: b.severity, found: 0, of: 0, via: {}, near: 0, wrongKind: 0, dropped: 0 };
      const x = out[key];
      x.of++;
      if (b.found) {
        x.found++;
        x.via[b.via] = (x.via[b.via] ?? 0) + 1;
      }
      if (b.near.length > 0) x.near++;
      if (b.wrongKind.length > 0) x.wrongKind++;
      if (b.droppedCandidates.length > 0) x.dropped++;
    }
  }
  return Object.values(out);
}

// Groups sample scores by a key function.
export function groupBy(samples, key) {
  const out = new Map();
  for (const s of samples) {
    const k = key(s);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(s);
  }
  return out;
}

// What differs between two runs other than the build: printed above any
// comparison so a model change is not read as a product change.
export function runDifferences(a, b) {
  const out = [];
  const same = (label, x, y) => {
    if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) out.push(`${label}: ${JSON.stringify(x ?? null)} then ${JSON.stringify(y ?? null)}`);
  };
  // Every reviewer with its version and model, the machine and the review settings.
  const reviewers = (m) => m.reviewers ?? (m.reviewer ? { [m.reviewer.name]: m.reviewer } : null);
  same("reviewers (name, version, model)", reviewers(a), reviewers(b));
  same("machine", a.machine, b.machine);
  same("concurrency", a.concurrency, b.concurrency);
  same("reviewer web access", a.review?.web, b.review?.web);
  same("review timeout in seconds", a.review?.timeoutSeconds, b.review?.timeoutSeconds);
  same("cases", [...(a.cases ?? [])].sort(), [...(b.cases ?? [])].sort());
  same("repeats", a.repeat, b.repeat);
  same("configurations", a.configs, b.configs);
  // An edited case: compared where both runs recorded what the case was built from.
  for (const [id, hash] of Object.entries(a.caseHashes ?? {})) {
    const other = b.caseHashes?.[id];
    if (other !== undefined && other !== hash) out.push(`the case ${id} changed between the runs (its files or its spec)`);
  }
  return out;
}

// Cases whose spec differs between two runs' own copies: the same review
// can score differently under them.
export function specDifferences(aSpecs, bSpecs) {
  return Object.keys(aSpecs)
    .filter((id) => bSpecs[id] !== undefined && JSON.stringify(aSpecs[id]) !== JSON.stringify(bSpecs[id]))
    .map((id) => `the spec of ${id} differs between the runs`);
}

// Bugs a config found in at least two samples of the old run and in at most
// one sample of the new: a regression by the repo's rule (one red sample is
// a reason to look; two in a row is a bug).
export function regressions(oldSamples, newSamples) {
  const index = (samples) => new Map(bugStability(samples).map((b) => [`${b.case}/${b.bug}`, b]));
  const out = [];
  for (const [config, olds] of groupBy(oldSamples, (s) => s.config)) {
    const news = newSamples.filter((s) => s.config === config);
    if (news.length === 0) continue;
    const before = index(olds);
    const after = index(news);
    for (const [key, b] of before) {
      const a = after.get(key);
      if (!a) continue;
      const missedBefore = b.of - b.found;
      const missedAfter = a.of - a.found;
      if (missedAfter >= 2 && missedAfter > missedBefore) out.push({ config, case: b.case, bug: b.bug, before: `${b.found}/${b.of}`, after: `${a.found}/${a.of}` });
    }
    const cleanBefore = olds.filter((s) => s.controls.of > 0 && s.controls.hit === 0).length;
    const cleanAfter = news.filter((s) => s.controls.of > 0 && s.controls.hit === 0).length;
    if (cleanAfter >= 2 && cleanAfter > cleanBefore) out.push({ config, case: "clean controls", bug: "a finding on a clean change", before: `${cleanBefore} samples`, after: `${cleanAfter} samples` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Score format 3: the population of planned first attempts, issue-level
// precision as bounds, unique-issue precision and redundancy, the location
// and planted-rule blocks kept apart and labelled, and the rules block. The
// format 2 functions above stay as they are: format 3 is built on them, and
// format 2 numbers (every saved attempt) are still computed beside it.
//
// Failure list, written before the code:
// 15. A planned review that never started, or failed, leaves the
//     denominator, so a crash looks like a better run: the population is
//     every planned job's first attempt, from the manifest's `jobs` (or, for
//     a run made before that list, from its cases, configurations and
//     repeats); a job with no attempt is unstarted, and an unstarted or
//     failed job misses every truth item of its case and adds no finding.
// 16. A retry that succeeded replaces the failure before it, so a rerun
//     picks the better result: a retry never enters the population; retries
//     are counted apart with their cost.
// 17. An unlisted finding counts as false, so a true issue nobody planted
//     lowers precision for good, or as true, so noise raises it: nothing
//     frozen rules on it, so it is unresolved, and precision is a pair of
//     bounds (unresolved counted wrong, then right) until a person rules.
//     A finding on a clean case is false, since the case is clean by spec.
// 18. Two findings on one issue raise precision: precision counts every
//     displayed finding, unique-issue precision counts each issue once, and
//     redundancy is the share of displayed findings beyond one per issue.
// 19. Today's planted precision, with test requests set apart, is pooled
//     with real-suite numbers: it is kept in its own labelled block, over
//     planted cases only, and the precision every suite shares counts every
//     displayed finding under one rule.
// 20. A line match is read as finding the issue: the location block (AACR's
//     line rule) is labelled a diagnostic and never decides anything.
// 21. A rule changes and old and new scores are compared as equal: every
//     constant, list and the matching code are in a hashed rules block that
//     each score carries, a test pins the hash to RULES_VERSION, and
//     rulesDifferences() names any difference between two scores.
export const RULES_VERSION = 3;
export const AACR_LINE_K = 1;
// The order classify() tries the rules in; the first that holds decides.
export const OUTCOME_ORDER = ["test-gap", "accepted", "hit", "wrong-kind", "near", "false"];
// How each outcome counts in precision. Correct and wrong count the same in
// both bounds; an unresolved one, which nothing frozen decides and no person
// has ruled on, is wrong in the lower bound and right in the upper. A near
// miss, a wrong kind and a request for a test are unresolved for precision
// and never find a truth item.
export const PRECISION = { correct: ["hit", "duplicate", "accepted"], wrong: ["false"], unresolved: ["unresolved", "near", "wrong-kind", "test-gap"] };
const OUTCOMES = [...PRECISION.correct, ...PRECISION.unresolved, ...PRECISION.wrong];
// The evidence behind an outcome that the frozen spec decides.
const FROZEN = new Set(["hit", "duplicate", "accepted", "false"]);

export const LOCATION_LABEL = "Location diagnostic: AACR's line rule (same file and side, lines overlapping or at most AACR_LINE_K apart). A board output; never an acceptance metric.";
export const PLANTED_LEGACY_LABEL = "Only planted cases: the format 2 rule, with duplicates, accepted side issues and requests for a test set apart. Never pooled with real-suite precision.";
export const ALL_ATTEMPTS_LABEL = "Every saved attempt, retries included and unstarted jobs left out, as score format 2 counted them. A diagnostic only.";

// The kind of case a suite holds.
const ORIGINS = { planted: "planted", aacr: "real", clean: "real", martian: "injected" };
export const originOf = (suite) => ORIGINS[suite ?? "planted"] ?? null;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const jobIdOf = (caseId, config, repeat) => `${caseId}/${config}/${repeat}`;
export const caseSetHash = (ids) => sha256([...ids].sort().join("\n"));

// The identity of a finding across runs: the case, the cited lines and the
// whitespace-normalised text. The same text on the same lines of the same
// case is the same finding; anything else is a different one.
export const normText = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
export function findingId(caseId, f) {
  const start = Number.isInteger(f.line_number) ? f.line_number : null;
  const end = start === null ? null : Math.max(f.line_end ?? start, start);
  return sha256(JSON.stringify([caseId, normPath(f.file_path), start, end, normText(f.title), normText(f.problem), normText(f.consequence), normText(f.fix)]));
}

// Format 3's outcome from classify()'s: an unlisted finding is unresolved,
// except on a clean case, where the spec makes every finding false.
export function outcomeOf(outcome, spec) {
  return outcome === "false" && !spec.clean ? "unresolved" : outcome;
}

const treatment = (outcome) => (PRECISION.correct.includes(outcome) ? "correct" : PRECISION.wrong.includes(outcome) ? "wrong" : "unresolved");

// The issue a finding raises: the truth item it finds, the side issue it
// names, or itself (by findingId) until a person consolidates it with others.
export function issueKey(f) {
  if (f.outcome === "hit" || f.outcome === "duplicate") return `truth:${f.bug}`;
  if (f.outcome === "accepted") return `extra:${f.extra}`;
  return `finding:${f.findingId}`;
}

// AACR's line rule (L1), as a location diagnostic: a finding matches a truth
// item on the same side of the same file when their lines overlap or lie at
// most `k` lines apart. Greedy in truth order, then finding order; each takes
// at most one of the other. knownNoise counts the findings that match only
// rejected truth (valid: false).
export function lineMatches(findings, truth, k = AACR_LINE_K) {
  const near = (f, t) => (f.side ?? "right") === (t.side ?? "right") && locations(t).some((l) => l.file === f.file && gap(f.line, Math.max(f.end ?? f.line, f.line), l.lines) <= k);
  const positive = truth.filter((t) => t.valid !== false);
  const rejected = truth.filter((t) => t.valid === false);
  const used = new Set();
  let matches = 0;
  for (const t of positive) {
    const i = findings.findIndex((f, j) => !used.has(j) && near(f, t));
    if (i === -1) continue;
    used.add(i);
    matches++;
  }
  const knownNoise = findings.filter((f) => rejected.some((t) => near(f, t)) && !positive.some((t) => near(f, t))).length;
  return { matches, generated: findings.length, expected: positive.length, knownNoise };
}

// The jobs a run planned: the manifest's `jobs` when it has them, else (a
// run made before the list existed) every repeat of every case and
// configuration it names, with the saved attempts filling in what it does
// not name. `attempts` are the saved attempts: { case, config, repeat }.
export function plannedJobs(manifest, attempts) {
  if (Array.isArray(manifest.jobs)) {
    return { from: "manifest", jobs: manifest.jobs.map((j) => ({ jobId: j.jobId, caseId: j.caseId, case: parseCaseId(j.caseId)?.name ?? j.caseId, config: j.config, repeat: j.repeat })) };
  }
  const suite = manifest.suite ?? "planted";
  const seen = (k) => [...new Set(attempts.map((a) => a[k]))].sort();
  const cases = manifest.cases ?? seen("case");
  const configs = manifest.configs ?? seen("config");
  const repeat = manifest.repeat ?? Math.max(0, ...attempts.map((a) => a.repeat));
  const idOf = (name) => (manifest.caseIds ?? []).find((id) => parseCaseId(id)?.name === name) ?? (manifest.caseHashes?.[name] ? `${suite}/${name}@${manifest.caseHashes[name].slice(0, 8)}` : `${suite}/${name}`);
  const jobs = [];
  for (let r = 1; r <= repeat; r++) for (const c of cases) for (const config of configs) jobs.push({ jobId: jobIdOf(idOf(c), config, r), caseId: idOf(c), case: c, config, repeat: r });
  return { from: "derived", jobs };
}

// The population of a run: each planned job with its first attempt (null
// when it never started). Retries, and first attempts of no planned job,
// are kept apart; a saved attempt that names another job than its folder is
// a problem.
export function population(manifest, attempts) {
  const { from, jobs } = plannedJobs(manifest, attempts);
  const key = (x) => `${x.case}\0${x.config}\0${x.repeat}`;
  const firsts = new Map(attempts.filter((a) => a.attempt === 1).map((a) => [key(a), a]));
  const planned = new Set(jobs.map(key));
  const problems = [];
  const out = jobs.map((job) => {
    const first = firsts.get(key(job)) ?? null;
    if (typeof first?.row?.jobId === "string" && first.row.jobId !== job.jobId) problems.push(`${job.case}/${job.config}/${job.repeat}: its sample.json names the job ${first.row.jobId}, but the manifest plans ${job.jobId} there`);
    return { ...job, first };
  });
  return { from, jobs: out, retries: attempts.filter((a) => a.attempt > 1), unplanned: attempts.filter((a) => a.attempt === 1 && !planned.has(key(a))), problems };
}

// One planned job, scored from its first attempt: `report` and `brief` are
// that attempt's (null when it wrote none), and `started` is false for a job
// with no attempt. `origin` is the kind of case (originOf).
export function scoreJob({ job, spec, report = null, brief = null, row = {}, origin = "planted", started = true }) {
  const planted = origin === "planted";
  const base = scoreSample({ spec, report, brief, row: { ...row, config: job.config, repeat: job.repeat, attempt: 1 }, testOnly: planted });
  const shown = shownFindings(report);
  const findings = base.findings.map((f, index) => {
    const g = { ...f, index, legacyOutcome: f.outcome, outcome: outcomeOf(f.outcome, spec), findingId: findingId(job.caseId, shown[index]), confidence: shown[index].confidence ?? null };
    return { ...g, issue: issueKey(g), evidenceKind: FROZEN.has(g.outcome) ? "frozen" : null };
  });
  const counted = (list) => ({ correct: list.filter((x) => x === "correct").length, unresolved: list.filter((x) => x === "unresolved").length, of: list.length });
  const issues = new Map(findings.map((f) => [f.issue, treatment(f.outcome)]));
  return {
    jobId: job.jobId,
    caseId: job.caseId,
    case: job.case ?? spec.id,
    config: job.config,
    repeat: job.repeat,
    origin,
    clean: spec.clean === true,
    status: started ? base.status : "unstarted",
    bugs: base.bugs,
    findings,
    controls: base.controls,
    issueRecall: { all: base.recall, criticalMajor: add(base.bySeverity.critical, base.bySeverity.major) },
    precision: counted(findings.map((f) => treatment(f.outcome))),
    issues: counted([...issues.values()]),
    location: lineMatches(base.findings, spec.bugs ?? []),
    plantedLegacy: planted ? base.precision : null,
    gaps: base.gaps,
    callers: base.callers,
    failures: started ? base.failures : [],
    wallMs: base.wallMs,
    reviewerMs: base.reviewerMs,
    costUsd: base.costUsd,
    turns: base.turns,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
  };
}

// Sums scored jobs (scoreJob) as ratios of sums; `retries` are the format 2
// samples of the retries, counted with their cost and nothing else.
export function summarizeJobs(jobs, retries = []) {
  const count = (status) => jobs.filter((j) => j.status === status).length;
  const total = (f) => jobs.reduce((a, j) => add(a, f(j)), ratio());
  const sum = (list, f) => list.reduce((a, j) => a + f(j), 0);
  const correct = sum(jobs, (j) => j.precision.correct);
  const unresolved = sum(jobs, (j) => j.precision.unresolved);
  const displayed = sum(jobs, (j) => j.precision.of);
  const issuesCorrect = sum(jobs, (j) => j.issues.correct);
  const issuesUnresolved = sum(jobs, (j) => j.issues.unresolved);
  const distinct = sum(jobs, (j) => j.issues.of);
  const recall = total((j) => j.issueRecall.all);
  const lower = { hit: correct, of: displayed };
  const p = value(lower);
  const r = value(recall);
  const matches = sum(jobs, (j) => j.location.matches);
  const generated = sum(jobs, (j) => j.location.generated);
  const expected = sum(jobs, (j) => j.location.expected);
  const planted = jobs.filter((j) => j.origin === "planted");
  const clean = jobs.filter((j) => j.clean);
  const retryCosts = nums(retries.map((s) => s.costUsd));
  const outcomes = {};
  for (const o of OUTCOMES) {
    const n = sum(jobs, (j) => j.findings.filter((f) => f.outcome === o).length);
    if (n > 0) outcomes[o] = n;
  }
  return {
    population: {
      planned: jobs.length,
      complete: count("complete"),
      incomplete: count("incomplete"),
      failed: count("failed"),
      unstarted: count("unstarted"),
      retries: retries.length,
      retryCostUsd: retries.length > 0 && retryCosts.length === 0 ? null : retryCosts.reduce((a, b) => a + b, 0),
    },
    issueRecall: { all: recall, criticalMajor: total((j) => j.issueRecall.criticalMajor) },
    precision: { lower, upper: { hit: correct + unresolved, of: displayed }, unresolved },
    uniqueIssuePrecision: { lower: { hit: issuesCorrect, of: distinct }, upper: { hit: issuesCorrect + issuesUnresolved, of: distinct } },
    redundancy: { hit: displayed - distinct, of: displayed },
    f1: p + r === 0 ? 0 : (2 * p * r) / (p + r),
    cleanFindingsPerCase: { findings: sum(clean, (j) => j.precision.of), cases: clean.length },
    controls: total((j) => j.controls),
    location: { label: LOCATION_LABEL, precision: { hit: matches, of: generated }, recall: { hit: matches, of: expected }, matches, generated, expected, knownNoise: sum(jobs, (j) => j.location.knownNoise) },
    plantedLegacy: planted.length === 0 ? null : { label: PLANTED_LEGACY_LABEL, precision: planted.reduce((a, j) => add(a, j.plantedLegacy), ratio()) },
    outcomes,
    brief: { gaps: total((j) => j.gaps), callers: total((j) => j.callers) },
    causes: null,
    wallMs: stats(jobs.map((j) => j.wallMs)),
    reviewerMs: stats(jobs.map((j) => j.reviewerMs)),
    costUsd: stats(jobs.map((j) => j.costUsd)),
    turns: stats(jobs.map((j) => j.turns)),
    inputTokens: stats(jobs.map((j) => j.inputTokens)),
    outputTokens: stats(jobs.map((j) => j.outputTokens)),
  };
}

// Why two scores' numbers cannot be compared as they stand: their rules
// differ, by version or, under one version, by hash. Empty when the rules
// are the same.
export function rulesDifferences(a, b) {
  const va = a?.version ?? null;
  const vb = b?.version ?? null;
  const ha = a?.hash ?? null;
  const hb = b?.hash ?? null;
  const rescore = "rescore both runs with one scorer before comparing them";
  if (va !== vb) return [`the scoring rules differ: version ${va} then ${vb}; ${rescore}`];
  if (ha === null || hb === null) return [`the scoring rules of one score are not recorded; ${rescore}`];
  if (ha !== hb) return [`the scoring rules differ under one version (${va}): a rule changed without a version bump; ${rescore}`];
  return [];
}

// The rules block every format 3 score carries. Its hash covers each
// constant and list, and the source of every function that decides an
// outcome, a match or a counted number, so any change to a rule changes it.
// The source is read from this file on disk, not from Function.toString(),
// because a test runner rewrites imported names inside a loaded function,
// and the tests and the command must hash the same text.
const RULE_CODE = ["normPath", "findingText", "locations", "gap", "names", "classify", "shownFindings", "scoreSample", "normText", "findingId", "outcomeOf", "treatment", "issueKey", "lineMatches", "plannedJobs", "population", "scoreJob", "summarizeJobs"];

// The text of one top-level declaration of this file: a one-line const, or
// a function from its first line to the brace that closes it at column 0.
function declaration(source, name) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`export function ${name}(`) || l.startsWith(`const ${name} = `) || l.startsWith(`export const ${name} = `));
  if (start === -1) throw new Error(`lib/score.mjs: no top-level declaration of ${name}, whose source the rules hash covers`);
  if (lines[start].startsWith("const ") || lines[start].startsWith("export const ")) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export function rulesHash(block) {
  const rest = { ...block };
  delete rest.hash;
  return sha256(canonical(rest));
}

const SOURCE = readFileSync(fileURLToPath(import.meta.url), "utf8");
const RULES_BLOCK = {
  version: RULES_VERSION,
  nearLines: NEAR_LINES,
  aacrLineK: AACR_LINE_K,
  overlap: "A finding's lines are [line_number, max(line_end, line_number)]. A hit needs a gap of 0 between them and one of the truth item's locations (its file and lines, or an entry of also), paths normalised.",
  words: { rule: "A mention matches case-insensitively, without stemming, at the start of the text or after a character that is not a letter or digit.", fields: ["title", "problem", "consequence", "fix", "description", "suggested_change"] },
  testOnly: { pattern: TEST_ONLY.source, flags: TEST_ONLY.flags, kinds: TEST_ONLY_KINDS, applies: "planted cases only; on a clean case such a finding is false" },
  order: OUTCOME_ORDER,
  precision: PRECISION,
  population: "Every planned job's first attempt. A job with no attempt is unstarted; an unstarted or failed job misses every truth item of its case and adds no finding. Retries are diagnostics only.",
  issues: "Findings that find one truth item are one issue, and so are findings on one accepted side issue; any other finding is its own issue, by findingId, until a person consolidates it.",
  code: sha256(RULE_CODE.map((name) => declaration(SOURCE, name).replace(/\s+/g, " ").trim()).join("\n")),
};
export const RULES = Object.freeze({ ...RULES_BLOCK, hash: rulesHash(RULES_BLOCK) });
