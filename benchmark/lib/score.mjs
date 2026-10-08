// Scores saved reviews against the planted bugs of their case specs.
// Nothing here starts a reviewer or reads anything but saved files.
//
// The vocabulary is the graph corpus's (packages/graph/corpus/score.ts): a
// score is a Ratio { hit, of }, `value` reads no checks as 1, and the names
// are the same where the meaning is the same: precision, recall, gaps,
// controls, failures.
//
// Matching one finding (file, line range, category, text) to a planted bug:
//   hit          same file, the ranges overlap, the category is one of the
//                bug's kinds, and, when the bug lists `mentions`, the
//                finding's text names one of them (case does not matter)
//   wrong-kind   a hit in every way but the category
//   near         a hit in every way but the lines: within NEAR_LINES lines
//                of the range, not on it
//   accepted     on a side issue the spec lists in `extras` (real, not
//                planted): left out of precision
//   test-gap     on a planted case, a finding whose title only asks for a
//                test (the brief hints at missing tests, and the planted
//                cases ship none by design, so it is true and not planted):
//                counted apart and left out of precision; on a clean case,
//                which ships its tests, it is false
//   false        anything else; on a clean case every finding is false
// A bug's `also` locations count as its own. When a finding could be a hit
// for two bugs, a bug whose `mentions` it satisfies wins over one with no
// `mentions`, then the bug whose anchor line is nearest, then the first.
//
// Failure list, written before the code:
// 1. A finding one line off counts as found, or silently as false: it is a
//    near miss, listed with its distance, and not a hit.
// 2. A finding on the right line about something else counts as found: a
//    wrong category is a wrong-kind, not a hit.
// 3. One finding is counted for two bugs whose ranges overlap: each finding
//    goes to one bug at most, by the order above.
// 4. Two findings for one bug count as two bugs found: recall counts bugs;
//    the second finding is a duplicate, still correct for precision.
// 5. A real issue the spec did not plant counts as false although the spec
//    lists it: extras are left out of precision.
// 6. A clean case scores well because it has nothing to miss: every finding
//    there is false, and its control fails.
// 7. A missing or incomplete report is left out, so a crash looks perfect:
//    a missing report misses every bug and is counted as failed; an
//    incomplete one is scored on what it holds and counted as incomplete.
// 8. Gap disclosure is read from data the reviewer never saw: it is read
//    from the saved brief, the text the reviewer was given.
// 9. A run with the graph off gets credit for gaps its brief never named:
//    gaps are counted from the brief's text only, so graph off scores 0.
// 10. A spec edited after a run changes that run's score: the scorer takes
//    the specs the run copied into its own folder.
// 11. Paths written differently (./a.py, a\b.py) do not match: both sides
//    are normalised.
// 12. Averages of averages over different sample counts mislead: ratios are
//    summed hits over summed checks; times and costs carry their count.
// 13. Two runs with different models, case sets or repeats read as a product
//    change: the comparison names every such difference above its table.
export const NEAR_LINES = 3;
export const SEVERITY_ORDER = ["critical", "major", "minor", "nitpick", "info"];

export const ratio = () => ({ hit: 0, of: 0 });
export const value = (r) => (r.of === 0 ? 1 : r.hit / r.of);
const add = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

export const normPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

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

function mentionsOk(bug, text) {
  return !bug.mentions || bug.mentions.some((m) => text.includes(m.toLowerCase()));
}

// The outcome of one finding against a spec.
export function classify(finding, spec) {
  const file = normPath(finding.file_path);
  const start = finding.line_number;
  const end = Math.max(finding.line_end ?? start, start);
  const text = findingText(finding);
  const bugs = spec.bugs ?? [];
  const dist = (bug) => {
    const ds = locations(bug).filter((l) => l.file === file).map((l) => gap(start, end, l.lines));
    return ds.length === 0 ? null : Math.min(...ds);
  };
  const kindOk = (bug) => bug.kind.includes(finding.category);
  const hits = bugs
    .map((bug, order) => ({ bug, order, d: dist(bug) }))
    .filter(({ bug, d }) => d === 0 && kindOk(bug) && mentionsOk(bug, text));
  if (hits.length > 0) {
    const anchorGap = (bug) => (normPath(bug.file) === file ? Math.abs(start - bug.anchor.line) : 0);
    hits.sort((a, b) => Number(Boolean(b.bug.mentions)) - Number(Boolean(a.bug.mentions)) || anchorGap(a.bug) - anchorGap(b.bug) || a.order - b.order);
    return { outcome: "hit", bug: hits[0].bug.id };
  }
  // A request for a test is about the missing test, not about a planted
  // bug whose lines it happens to span.
  if (!spec.clean && TEST_GAP.test(String(finding.title ?? ""))) return { outcome: "test-gap" };
  const wrong = bugs.find((bug) => dist(bug) === 0 && mentionsOk(bug, text) && !kindOk(bug));
  if (wrong) return { outcome: "wrong-kind", bug: wrong.id, expected: wrong.kind };
  const near = bugs
    .map((bug) => ({ bug, d: dist(bug) }))
    .filter(({ bug, d }) => d !== null && d > 0 && d <= NEAR_LINES && kindOk(bug) && mentionsOk(bug, text))
    .sort((a, b) => a.d - b.d)[0];
  if (near) return { outcome: "near", bug: near.bug.id, distance: near.d };
  const extra = (spec.extras ?? []).find((x) => normPath(x.file) === file && gap(start, end, x.lines) === 0);
  if (extra) return { outcome: "accepted", why: extra.why };
  return { outcome: "false" };
}

// A title that asks for a test: "has no covering test", "Missing tests for
// X", "X is untested", "no test coverage".
export const TEST_GAP = /\b(tests?|untested|coverage)\b/i;
// Outcomes left out of precision.
const UNCOUNTED = new Set(["accepted", "test-gap"]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
export function scoreSample({ spec, report, brief, row = {} }) {
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
    ...classify(f, spec),
  }));
  const status = report === null ? "failed" : report.completion?.status === "complete" ? "complete" : "incomplete";
  const recall = ratio();
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, ratio()]));
  const bugs = (spec.bugs ?? []).map((bug) => {
    const mine = findings.filter((f) => f.bug === bug.id);
    const hits = mine.filter((f) => f.outcome === "hit");
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
      findings: hits.length,
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
  const controls = spec.clean ? { hit: status !== "failed" && counted === 0 ? 1 : 0, of: 1 } : ratio();
  const brief_ = scoreBrief(spec, brief);
  const usage = report?.completion?.reviewer?.usage ?? null;
  return {
    case: spec.id,
    config: row.config ?? null,
    repeat: row.repeat ?? null,
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
  same("reviewer model", a.reviewer?.model, b.reviewer?.model);
  same("reviewer", `${a.reviewer?.name} ${a.reviewer?.version}`, `${b.reviewer?.name} ${b.reviewer?.version}`);
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
