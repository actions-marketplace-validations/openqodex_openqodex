#!/usr/bin/env node
// Validates the acceptance rule (decide.mjs) before the first live decision
// (PLAN-benchmark 4.11), and writes one `validation` line to the reviewer
// ledger. decide.mjs refuses a live decision until the last such line
// passes and names the rule's hash.
//
//   node benchmark/loop/validate.mjs --run <run> [--specs <folder>] [--run <run> ...]
//        [--ledger <file>] [--decisions <file>] [--sequences 1000] [--looks 10] [--dry-run] [--json]
//
// Two parts, both without a model call:
// 1. Controlled datasets. A simulated world of planted-style cases (its
//    shape below, from the saved runs: most truth items found in every
//    review, some never, some now and then; whole cases now and then missed
//    in every review of a run; a few false findings; severity mostly given
//    the same way for the same item; costs and times varying by case and a
//    little by review). Null: --sequences sequences of --looks looks each,
//    every look a fresh pair of runs drawn from the same world, decided at
//    its look number t (every look able to accept, the worst case for the
//    error budget). Harm: a third of the cases lose most of their finds.
//    Power: a candidate that finds most of what the parent misses.
// 2. Saved data. For every --run and each configuration with two repeats or
//    more: a null change from two disjoint repeats of the run (1 against 2,
//    1 against 3, 2 against 3), and a harmful change made from the same
//    pair by removing every hit from a fixed share of the cases (HARM_SHARE,
//    chosen by a hash of the case id) in the candidate's reports, scored
//    again by score.mjs. Each is decided at look 1, the most permissive
//    bound, with the requirements of acceptance (three repeats, both laptop
//    reviewers) set aside, so the bounds and hard rules alone are tested.
//    The record is the default one of benchmark/loop/levers.json, with
//    recall, precision and the incomplete rate each the primary in turn.
//
// The line passes when no null change is accepted, the harmful
// constructed pair is reverted, the simulated gain is accepted at least
// once, at least 1,000 sequences ran, no saved null change is accepted and
// no saved harmful change is accepted (a missed harm).
//
// Exit codes: 0 the line is written and passes; 1 written and fails; 2
// refused or failed.
//
// Failure list, written before the code:
// 1. The rule is first used live, so a false accept is found by the loop
//    itself: nothing decides before this line passes (decide.mjs).
// 2. The simulated world is one where nothing can be accepted, so "never
//    accepted" proves nothing: the same world must accept a real gain, and
//    the test suite shows a review-level bootstrap accepting its nulls.
// 3. A null pair from one run reuses reviews on both sides: the repeats
//    are disjoint.
// 4. The harm is made by hand, or differs from run to run: it is the
//    removal of every hit in a fixed share of cases picked by a hash of the
//    case id, and the reports are scored again by the scorer, not edited
//    scores.
// 5. A validation is rerun until it passes: each run appends its own line,
//    pass or fail, and decide.mjs reads only the last.
// 6. The line names the hash of files other than the code that ran (a rule
//    file edited while the checks ran): the rule's files are hashed when
//    this module starts, before any of them is loaded (the static imports
//    below are Node's and rule-hash.mjs only; the rest is imported after the
//    hash), the line names that hash, and the files are hashed again under
//    the ledger's lock before the line is written; a difference refuses the
//    write.
// 7. A reader of the ledger sees half a line: the line goes in through
//    decide.mjs appendLedgerLine (a temp file renamed over the ledger).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ruleHash } from "./rule-hash.mjs";

// The hash of the rule's files as they were when this module started, before
// any of them was loaded.
export const HASH_AT_LOAD = ruleHash();

const { mulberry32, seedOf } = await import("../lib/interval.mjs");
const { decisionsPath, loadRun, scoreRun } = await import("../score.mjs");
const { GATE_METRICS, comparePairs, makeSide, metricOf, readRulings, runFolder } = await import("./compare.mjs");
const { MIN_SEQUENCES, Refusal, alphaAt, appendLedgerLine, decide, primaryVerdict } = await import("./decide.mjs");
const { ToolError } = await import("./leak-check.mjs");
const { LEDGER, LEVERS_PATH, lockLedger, readLedger } = await import("./propose.mjs");

export const SIM_DEFAULTS = Object.freeze({ seed: "P3-04 validation", cases: 50, cleanCases: 20, bugsPerCase: 3, repeats: 3, looks: 10, sequences: 1000 });
// The share of cases whose hits the saved harmful change removes.
export const HARM_SHARE = 0.5;
// The primaries the saved-data checks take in turn; the simulation takes the
// first two (its world has no incomplete review, so that primary never moves).
const PRIMARIES = ["recall", "precision", "incompleteRate"];
const SIM_PRIMARIES = ["recall", "precision"];

// The default record of the levers registry, as a hypothetical change.
export function defaultRecord(primary = "recall", { paths = ["server"], target = "server" } = {}) {
  const reg = JSON.parse(readFileSync(LEVERS_PATH, "utf8"));
  return { lever: "validation", title: "validation", hypothesis: "none", paths, target, aim: "quality", primary: { metric: primary, better: reg.metrics[primary].better }, acceptableLoss: Object.fromEntries(Object.entries(reg.metrics).map(([m, d]) => [m, d.loss])) };
}

// ---------------------------------------------------------------------------
// The simulated world.

const pad = (n) => String(n).padStart(3, "0");
// A normal draw from two uniform ones.
const gauss = (rand) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());

// The world's shape, read from the saved runs 2026-10-08-752b77f (graph off
// and on, three repeats) and 2026-10-09-4850f66, rounded: of the truth
// items, 78 percent were found in every review, 11 in two of three, 3 in
// one, 8 in none; 85 percent of the items found more than once were given
// the same severity every time, and about three in four finds had the exact
// severity; a review showed 0.12 findings that are not truth items on
// average, unevenly across cases; a review's cost varied about 10 percent
// within its case, its time about 15. Whole cases missed in every review of
// a run are rare (slip). Clean cases rarely draw a finding. No review was
// incomplete.
export const WORLD = Object.freeze({
  found: [
    [0.78, 0.99],
    [0.11, 0.67],
    [0.03, 0.33],
    [0.08, 0.02],
  ],
  sameSeverity: 0.85,
  exactWhenSame: 0.8,
  falseRates: [0, 0, 0.1, 0.3],
  slip: 0.03,
  costSpread: 0.1,
  secondsSpread: 0.15,
  cleanFalseRate: 0.005,
});

// The world's cases, drawn once from its seed. Each truth item has its
// chance of being found in a review, and either a severity given the same
// way every time (exact or not) or one given either way; each case its
// chance of being missed whole in a run, its rate of findings that are not
// truth items, and its cost and time.
export function simulatedWorld({ seed = SIM_DEFAULTS.seed, cases = SIM_DEFAULTS.cases, cleanCases = SIM_DEFAULTS.cleanCases, bugsPerCase = SIM_DEFAULTS.bugsPerCase, profile = WORLD } = {}) {
  const rand = mulberry32(seedOf("world", seed));
  const severities = ["critical", "major", "major", "minor", "minor", "nitpick"];
  const foundChance = () => {
    let u = rand();
    for (const [share, p] of profile.found) {
      if (u < share) return p;
      u -= share;
    }
    return profile.found.at(-1)[1];
  };
  const list = [];
  for (let c = 0; c < cases; c++) {
    const bugs = [];
    for (let b = 0; b < bugsPerCase; b++) bugs.push({ id: `b${b + 1}`, severity: severities[Math.floor(rand() * severities.length)], p: foundChance(), exact: rand() < profile.sameSeverity ? rand() < profile.exactWhenSame : null });
    list.push({ caseId: `planted/sim-${pad(c)}@00000000`, clean: false, bugs, slip: profile.slip, falseRate: profile.falseRates[Math.floor(rand() * profile.falseRates.length)], cost: 0.05 + 0.15 * rand(), seconds: 15 + 35 * rand() });
  }
  for (let c = 0; c < cleanCases; c++) list.push({ caseId: `planted/sim-clean-${pad(c)}@00000000`, clean: true, bugs: [], slip: 0, falseRate: profile.cleanFalseRate, cost: 0.05 + 0.1 * rand(), seconds: 10 + 20 * rand() });
  return { seed, profile, cases: list };
}

// One review of a simulated case, in the shape lib/score.mjs scoreJob
// gives, with the fields the comparison reads.
function simReview(c, { repeat, config, found, exact, falseCount, cost, seconds }) {
  const hits = c.bugs.filter((b) => found[b.id]).map((b) => ({ outcome: "hit", bug: b.id, severity: b.severity, severityAgreement: exact[b.id] ? "exact" : "one-off" }));
  const findings = [...hits, ...Array.from({ length: falseCount }, () => ({ outcome: c.clean ? "false" : "ruled-false", bug: null, severityAgreement: null }))];
  const cm = c.bugs.filter((b) => b.severity === "critical" || b.severity === "major");
  return {
    jobId: `${c.caseId}/${config}/${repeat}`,
    caseId: c.caseId,
    case: c.caseId,
    config,
    repeat,
    origin: "planted",
    clean: c.clean,
    status: "complete",
    bugs: c.bugs.map((b) => ({ id: b.id, severity: b.severity, found: found[b.id] })),
    findings,
    issueRecall: { all: { hit: hits.length, of: c.bugs.length }, criticalMajor: { hit: cm.filter((b) => found[b.id]).length, of: cm.length } },
    precision: { correct: hits.length, unresolved: 0, of: findings.length },
    issues: { correct: hits.length, unresolved: 0, of: findings.length },
    costUsd: cost,
    wallMs: seconds * 1000,
    budgetRefused: false,
    undeliveredComplete: false,
  };
}

// One run of the world as a compare.mjs side. `effect`: null (the world as
// it is), "better" (most of what a review misses is found), or "harm" (a
// third of the cases, every third one, lose most of their finds).
export function drawSide(world, rand, { runId, effect = null, repeats = SIM_DEFAULTS.repeats, path = "server", reviewer = "model:simulated" } = {}) {
  const config = `${reviewer}-graph-on`;
  const jobs = [];
  world.cases.forEach((c, i) => {
    // A whole case missed in every review of this run.
    const slipped = rand() < (effect === "better" ? c.slip / 2 : c.slip);
    for (let r = 1; r <= repeats; r++) {
      const found = {};
      const exact = {};
      for (const b of c.bugs) {
        let p = slipped ? b.p * 0.2 : b.p;
        if (effect === "better") p = 1 - 0.25 * (1 - p);
        if (effect === "harm" && i % 3 === 0) p *= 0.2;
        found[b.id] = rand() < p;
        exact[b.id] = b.exact ?? rand() < 0.5;
      }
      let falseCount = 0;
      while (rand() < c.falseRate && falseCount < 10) falseCount++;
      jobs.push(simReview(c, { repeat: r, config, found, exact, falseCount, cost: c.cost * Math.exp(world.profile.costSpread * gauss(rand)), seconds: c.seconds * Math.exp(world.profile.secondsSpread * gauss(rand)) }));
    }
  });
  return makeSide({ runId, suite: "planted", split: "dev", path, reviewer, model: "simulated", config, rules: { version: 5, hash: "simulated" }, jobs });
}

// Whether a look accepts: the primary alone first, and the whole rule only
// when the primary passes, which gives the same answer at a fraction of the
// work (the same seeds, the same bounds). A primary that did not move the
// better way is not tested at all: swapping every cluster negates the
// change, so the sign-flip spread is symmetric about zero, and a change on
// the wrong side of zero has a one-sided p of a half or more, never inside
// a look's share.
function accepts({ id, record, pair, look }) {
  const metric = metricOf(record.primary.metric);
  const sum = (side, bound) => side.jobs.reduce((t, j) => { const r = metric.job(j, bound); return { hit: t.hit + r.hit, of: t.of + r.of }; }, { hit: 0, of: 0 });
  const value = (r) => (r.of === 0 ? 1 : r.hit / r.of);
  const moved = value(sum(pair.candidate, "lower")) - value(sum(pair.parent, "upper"));
  if (metric.better === "higher" ? moved <= 0 : moved >= 0) return { primary: false, accepted: false };
  const share = alphaAt(look) / GATE_METRICS.length;
  const only = comparePairs([pair], { alpha: share, seed: id, metrics: [record.primary.metric] });
  if (primaryVerdict(only.cells[0].strata.pooled.metrics[record.primary.metric], share) !== "better") return { primary: false, accepted: false };
  return { primary: true, accepted: decide({ id, record, pairs: [pair], look, stage: 3 }).decision === "accepted" };
}

// Null look sequences: every look a fresh pair drawn from one world,
// decided at its look number, the primary taking turns among PRIMARIES.
export function simulateNull({ sequences = SIM_DEFAULTS.sequences, looks = SIM_DEFAULTS.looks, seed = SIM_DEFAULTS.seed, world: shape = {} } = {}) {
  const world = simulatedWorld({ seed, ...shape });
  const rand = mulberry32(seedOf("null", seed));
  const records = Object.fromEntries(SIM_PRIMARIES.map((p) => [p, defaultRecord(p)]));
  let accepted = 0;
  let primaryPassed = 0;
  const acceptedAt = [];
  for (let s = 0; s < sequences; s++) {
    for (let t = 1; t <= looks; t++) {
      const record = records[SIM_PRIMARIES[(s + t) % SIM_PRIMARIES.length]];
      const pair = { parent: drawSide(world, rand, { runId: `null-${s}-${t}-parent` }), candidate: drawSide(world, rand, { runId: `null-${s}-${t}-candidate` }) };
      const r = accepts({ id: `null-${s}-${t}`, record, pair, look: t });
      if (r.primary) primaryPassed++;
      if (r.accepted) {
        accepted++;
        acceptedAt.push({ sequence: s, look: t, primary: record.primary.metric });
      }
    }
  }
  // The rule's own bound on false accepts per sequence: the primary's share
  // of every look's budget, summed.
  let bound = 0;
  for (let t = 1; t <= looks; t++) bound += alphaAt(t) / GATE_METRICS.length;
  return { seed, cases: world.cases.length, sequences, looks, accepted, primaryPassed, acceptedAt, boundPerSequence: bound };
}

// A real gain at look 1: how often the rule accepts it.
export function simulatePower({ pairs = 40, seed = SIM_DEFAULTS.seed, world: shape = {} } = {}) {
  const world = simulatedWorld({ seed, ...shape });
  const rand = mulberry32(seedOf("power", seed));
  const record = defaultRecord("recall");
  let accepted = 0;
  for (let i = 0; i < pairs; i++) {
    const pair = { parent: drawSide(world, rand, { runId: `power-${i}-parent` }), candidate: drawSide(world, rand, { runId: `power-${i}-candidate`, effect: "better" }) };
    if (accepts({ id: `power-${i}`, record, pair, look: 1 }).accepted) accepted++;
  }
  return { of: pairs, accepted, look: 1, effect: "the candidate finds three quarters of what a review of the parent misses" };
}

// The constructed harmful pair, decided at look 1.
export function simulateHarm({ seed = SIM_DEFAULTS.seed, world: shape = {} } = {}) {
  const world = simulatedWorld({ seed, ...shape });
  const rand = mulberry32(seedOf("harm", seed));
  const pair = { parent: drawSide(world, rand, { runId: "harm-parent" }), candidate: drawSide(world, rand, { runId: "harm-candidate", effect: "harm" }) };
  const d = decide({ id: "harm", record: defaultRecord("recall"), pairs: [pair], look: 1, stage: 3 });
  return { decision: d.decision, reason: d.reason, look: 1, effect: "every third case finds a fifth of what it found" };
}

// ---------------------------------------------------------------------------
// Saved data.

// Whether a case is in the harmed share: a fixed hash of its id.
export const harmed = (caseId) => createHash("sha256").update(`openqodex-harm\0${caseId}`).digest().readUInt32BE(0) / 2 ** 32 < HARM_SHARE;

// The saved run scored twice: as saved, and with every hit of the harmed
// cases removed from the reports of `repeats`. Returns both scorings' jobs
// per configuration.
function scoredWithHarm({ folder, specs, decisions }) {
  const specsDir = specs === null ? null : existsSync(specs) ? resolve(specs) : join(folder, specs);
  const plain = loadRun(folder, { specsDir });
  const asSaved = scoreRun(plain, { decisions: decisions.lines, people: decisions.people });
  // The hits of each first attempt, by finding index, from the scoring as saved.
  const hits = new Map(asSaved.jobs.map((j) => [`${j.case}\0${j.config}\0${j.repeat}`, new Set(j.findings.filter((f) => f.outcome === "hit" || f.outcome === "duplicate").map((f) => f.index))]));
  const harmedRun = loadRun(folder, { specsDir });
  for (const a of harmedRun.attempts) {
    if (a.attempt !== 1 || !a.report) continue;
    const caseId = asSaved.jobs.find((j) => j.case === a.case)?.caseId;
    if (!caseId || !harmed(caseId)) continue;
    const drop = hits.get(`${a.case}\0${a.config}\0${a.repeat}`) ?? new Set();
    // shownFindings order: findings, then outside_change.
    const n = (a.report.findings ?? []).length;
    a.report = { ...a.report, findings: (a.report.findings ?? []).filter((_, i) => !drop.has(i)), outside_change: (a.report.outside_change ?? []).filter((_, i) => !drop.has(n + i)) };
  }
  const withHarm = scoreRun(harmedRun, { decisions: decisions.lines, people: decisions.people });
  return { asSaved, withHarm, manifest: plain.manifest };
}

const sideFrom = ({ scored, manifest, folder, config, repeat }) => {
  const { score, jobs } = scored;
  return makeSide({ runId: manifest.runId ?? basename(folder), suite: score.suite, split: score.split, splitHash: score.splitHash, path: score.path, config, rules: { version: score.rules.version, hash: score.rules.hash }, build: score.build, groups: score.intervals?.groups ?? null, jobs: jobs.filter((j) => j.config === config && j.repeat === repeat).map((j) => ({ ...j, budgetRefused: false, undeliveredComplete: false })) });
};

// Null and harmful changes from every saved run: each pair of disjoint
// repeats of each configuration, decided at look 1 under each primary,
// with the requirements of acceptance set aside.
export function validateSaved({ runs, decisions = { lines: [], people: [] } }) {
  const nullPairs = [];
  const harmPairs = [];
  for (const { folder: given, specs = null } of runs) {
    const folder = runFolder(given);
    const { asSaved, withHarm, manifest } = scoredWithHarm({ folder, specs, decisions });
    for (const config of Object.keys(asSaved.score.byConfig)) {
      const repeats = [...new Set(asSaved.jobs.filter((j) => j.config === config).map((j) => j.repeat))].sort((a, b) => a - b);
      for (let i = 0; i < repeats.length; i++) {
        for (let k = i + 1; k < repeats.length; k++) {
          const parent = sideFrom({ scored: asSaved, manifest, folder, config, repeat: repeats[i] });
          const plain = sideFrom({ scored: asSaved, manifest, folder, config, repeat: repeats[k] });
          const hurt = sideFrom({ scored: withHarm, manifest, folder, config, repeat: repeats[k] });
          // Different run ids, so the pair is not refused as the same reviews: the repeats are disjoint.
          const pairOf = (candidate, tag) => ({ parent: { ...parent, runId: `${parent.runId}@${repeats[i]}` }, candidate: { ...candidate, runId: `${candidate.runId}@${repeats[k]}${tag}` } });
          for (const primary of PRIMARIES) {
            const record = defaultRecord(primary, { paths: [parent.path], target: parent.path });
            const decided = (pair) => {
              const d = decide({ id: `validation|${parent.runId}|${config}|${repeats[i]}|${repeats[k]}|${primary}`, record, pairs: [pair], look: 1, stage: 3 });
              // Acceptance by the bounds and hard rules alone: the requirements set aside.
              const statistical = d.harms.length === 0 && d.open.length === d.requirements.missing.length;
              return { decision: d.decision, statistical: statistical ? "accept" : d.harms.length > 0 ? "revert" : "inconclusive", primaryVerdict: d.cells[0].verdicts.pooled[primary], reason: d.reason };
            };
            const what = { run: parent.runId, specs, config, parentRepeat: repeats[i], candidateRepeat: repeats[k], primary };
            nullPairs.push({ ...what, ...decided(pairOf(plain, "")) });
            const recallDrop = harmDrop(asSaved, withHarm, config, repeats[k]);
            harmPairs.push({ ...what, hitsRemoved: recallDrop, ...decided(pairOf(hurt, "+harm")) });
          }
        }
      }
    }
  }
  return {
    harmShare: HARM_SHARE,
    nullPairs,
    harmPairs,
    falseAccepts: nullPairs.filter((p) => p.statistical === "accept").length,
    missedHarms: harmPairs.filter((p) => p.statistical === "accept").length,
    harmsReverted: harmPairs.filter((p) => p.statistical === "revert").length,
  };
}

// How many hits the harm removed from one repeat of one configuration.
function harmDrop(asSaved, withHarm, config, repeat) {
  const hits = (s) => s.jobs.filter((j) => j.config === config && j.repeat === repeat).reduce((n, j) => n + j.issueRecall.all.hit, 0);
  return hits(asSaved) - hits(withHarm);
}

// ---------------------------------------------------------------------------
// The ledger line.

export function validationLine({ simulation, saved, at = new Date().toISOString(), id = "VAL-0001", runs = [], hash = HASH_AT_LOAD }) {
  const fails = [];
  if (simulation.sequences < MIN_SEQUENCES) fails.push(`only ${simulation.sequences} simulated sequences, fewer than ${MIN_SEQUENCES}`);
  if (simulation.accepted > 0) fails.push(`${simulation.accepted} simulated null changes accepted`);
  if (simulation.harm?.decision !== "reverted") fails.push(`the constructed harmful pair was ${simulation.harm?.decision ?? "not decided"}, not reverted`);
  if (!(simulation.power?.accepted > 0)) fails.push("the simulated gain was never accepted, so the rule may accept nothing at all");
  if (saved.falseAccepts > 0) fails.push(`${saved.falseAccepts} saved null changes accepted`);
  if (saved.missedHarms > 0) fails.push(`${saved.missedHarms} saved harmful changes accepted`);
  if (saved.nullPairs.length === 0) fails.push("no saved run held two repeats of one configuration");
  return {
    v: 1,
    id,
    at,
    event: "validation",
    ruleHash: hash,
    look: null,
    alpha: null,
    runs,
    simulation,
    saved,
    pass: fails.length === 0,
    reason: fails.length === 0 ? "no null change accepted, the harmful pairs not accepted and the constructed one reverted, and a real gain accepted" : fails.join("; "),
  };
}

const nextId = (lines) => `VAL-${String(lines.reduce((n, l) => Math.max(n, Number(/^VAL-(\d+)$/.exec(l.id)?.[1] ?? 0)), 0) + 1).padStart(4, "0")}`;

// Writes one validation line under the ledger's lock: `build(id)` makes the
// line with the next VAL id. The rule's files are hashed again first, and
// the line is refused when they are not the files `hashAtLoad` (taken
// before the checks loaded them) names (failure 6). Returns the line.
export function writeValidationLine({ ledger, build, hashAtLoad = HASH_AT_LOAD }) {
  mkdirSync(dirname(ledger), { recursive: true });
  const lock = lockLedger(ledger);
  try {
    const now = ruleHash();
    if (now !== hashAtLoad) throw new Refusal(`refused: the rule's files changed while the validation ran (hash ${hashAtLoad.slice(0, 12)} when they were loaded, ${now.slice(0, 12)} now); nothing is written, validate again`);
    const line = build(nextId(readLedger(ledger)));
    if (line.ruleHash !== hashAtLoad) throw new Refusal(`refused: the line names the rule hash ${String(line.ruleHash).slice(0, 12)}, not the ${hashAtLoad.slice(0, 12)} of the code that ran`);
    if (!lock.held()) throw new Refusal(`the ledger lock ${ledger}.lock was taken over; nothing is written, validate again`);
    appendLedgerLine(ledger, line);
    return line;
  } finally {
    lock.release();
  }
}

function parseArgs(argv) {
  const o = { runs: [], ledger: LEDGER, decisions: decisionsPath, sequences: SIM_DEFAULTS.sequences, looks: SIM_DEFAULTS.looks, dryRun: false, json: false };
  const value = (i) => {
    if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) throw new Refusal(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  const count = (s, name) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new Refusal(`${name} must be a whole number of 1 or more`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run") o.runs.push({ folder: value(i++), specs: null });
    else if (a === "--specs") {
      if (o.runs.length === 0) throw new Refusal("--specs follows the --run it applies to");
      o.runs.at(-1).specs = value(i++);
    } else if (a === "--ledger") o.ledger = resolve(value(i++));
    else if (a === "--decisions") o.decisions = resolve(value(i++));
    else if (a === "--sequences") o.sequences = count(value(i++), "--sequences");
    else if (a === "--looks") o.looks = count(value(i++), "--looks");
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--json") o.json = true;
    else throw new Refusal(`unknown argument ${a}`);
  }
  if (o.runs.length === 0) throw new Refusal("name the saved runs with --run <run> (a folder, or a run id under benchmark/results)");
  return o;
}

function main() {
  try {
    const o = parseArgs(process.argv.slice(2));
    const decisions = readRulings(o.decisions);
    const saved = validateSaved({ runs: o.runs, decisions });
    const simulation = { ...simulateNull({ sequences: o.sequences, looks: o.looks }), harm: simulateHarm(), power: simulatePower() };
    const runs = o.runs.map((r) => ({ runId: basename(runFolder(r.folder)), specs: r.specs }));
    const summary = (line) =>
      [
        `Validation of the acceptance rule (hash ${line.ruleHash.slice(0, 12)}):`,
        `- simulated: ${simulation.accepted} of ${simulation.sequences} null look sequences (${simulation.looks} looks each, ${simulation.cases} cases) accepted a change; the primary passed by chance at ${simulation.primaryPassed} of ${simulation.sequences * simulation.looks} looks; the rule's bound is ${simulation.boundPerSequence.toPrecision(3)} per sequence`,
        `- simulated harm: ${simulation.harm.decision}; simulated gain accepted in ${simulation.power.accepted} of ${simulation.power.of} pairs`,
        `- saved: ${saved.nullPairs.length} null decisions, ${saved.falseAccepts} accepted; ${saved.harmPairs.length} harmful decisions, ${saved.missedHarms} accepted, ${saved.harmsReverted} reverted on evidence`,
        `- ${line.pass ? "pass" : "fail"}: ${line.reason}`,
      ].join("\n");
    if (o.dryRun) {
      const line = validationLine({ simulation, saved, runs });
      console.log(o.json ? JSON.stringify(line, null, 2) : `${summary(line)}\n(dry run: nothing written)`);
      process.exit(line.pass ? 0 : 1);
    }
    const line = writeValidationLine({ ledger: o.ledger, build: (id) => validationLine({ simulation, saved, runs, id }) });
    console.log(o.json ? JSON.stringify(line, null, 2) : `${summary(line)}\nWritten to ${o.ledger} as ${line.id}.`);
    process.exit(line.pass ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Refusal || error instanceof ToolError ? error.message : error.stack);
    process.exit(2);
  }
}

// Run as a script, not imported: Node gives import.meta.url the real path, so argv[1] is compared by its real path.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
