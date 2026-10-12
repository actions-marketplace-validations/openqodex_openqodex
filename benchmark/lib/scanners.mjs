// What each scanner contributed to a saved run, from its files only: what it
// raised, what each filter and the reviewer did with it, which truth items it
// found, what in its remit it missed, what the ensemble loses without it,
// and at what time cost (the benchmark plan, part P2 4.2 to 4.4). And the
// first clause of the scanner keep rule, K1, for two runs. Nothing here
// reads a file or starts a process; benchmark/scanners.mjs does the reading.
//
// Definitions, per sample (the first attempt of a planned job that saved a
// scan.json):
// - A place: a kept candidate, or a finding dedup merged into one, at the
//   lines the trail recorded for it; only where the trail did not record it
//   (a scan before the trail, or a trail past its cap) at the lines of the
//   candidate it went into, from alsoReportedBy, and counted. Each place
//   speaks for its own scanner, so dedup never hides the losing scanner's
//   work; a merged finding counts only when the candidate it went into is
//   kept. OpenQodex's own candidates speak for "suppression" or "settings"
//   (lib/scan-score.mjs findersOf), and a custom scanner never does.
// - Found (issue-level, what K1 and the tables count): a place on one of
//   the truth item's places (its file and lines, or an `also` entry) whose
//   scanner the item expects (found_by), or whose rule id, message or token
//   names the item's words (mentions, or matchSignatures on real truth) by
//   the scorer's word rule. The scanner-only scorer's hit rule (rule S1 of
//   lib/scan-score.mjs), applied to every place: a side issue the spec lists
//   in `extras` is matched first, and a place that finds two items goes to
//   the one whose anchor is nearest, then the first.
// - Located (location only): a place on the item's lines, whatever it says.
//   A diagnostic; it never decides anything.
// - Reachable: the item has a line the change touched (its onChangedLines,
//   or the case's changed lines when the command could build the case);
//   unknown otherwise.
// - File remit of S: the item is reachable and one of its files is in the
//   paths the scan's selection handed S. Without a selection, or with
//   reachability unknown, the remit is unknown and never guessed. The class
//   remit (P2 4.2) needs pooled accepted baselines and is not learned here:
//   the remit is the file remit.
// - Miss: in S's remit, S ran, S did not find it. Infra miss: in S's file
//   remit and S did not run (not_installed, installing, failed, disabled,
//   untrusted, or left out of the scan). Counted apart, never as a miss.
// - Unique: found by S and by no other scanner in that sample. Leave one
//   out of S: the items S found alone (a merged finding of another scanner
//   comes back as a candidate, and already counts for that scanner), and the
//   candidates saved: S's kept candidates that absorbed no other scanner's
//   finding.
// - Raised, held, dropped, unanswered: a shown finding names the candidate;
//   a finding of the saved final answer (submission.json) names it and
//   finalize did not show it (under the confidence floor or below the
//   severity threshold, which the report lists without the candidate); the
//   reviewer dropped it (its class from lib/drops.mjs); none of these, or a
//   review that saved no final answer. A scanner-only run's candidates are
//   unreviewed.
//
// Failure list, written before the code:
// 1. A scanner that was not installed reads as missing what it never looked
//    at (brakeman, golangci and rubocop in both committed runs): truth in
//    its file remit is an infra miss, apart from misses and recall, and a
//    comparison is refused while one stands; a scan with no selection
//    leaves the remit unknown, and the comparison is refused then too.
// 2. Dedup hides the losing scanner's work: a merged trail entry and a
//    merged token in alsoReportedBy count for their own scanner, so leaving
//    out the scanner that absorbed them loses nothing they found.
// 3. One item counts as unique twice: unique and leave-one-out count
//    (sample, item) pairs, however many candidates and places of one
//    scanner sit on it, and never when a second scanner found it too.
// 4. Ratios are averaged over samples, so a sample with one candidate
//    weighs as much as one with thirty: every ratio is summed hits over
//    summed checks, and every time carries its count.
// 5. Two runs that read other Semgrep rule packs, or ran another scanner
//    toolchain, are compared as a product change: packs and the toolchain
//    must match, unknown or mixed packs and an unrecorded toolchain are
//    refused, and only the one input the change under test names (a pin
//    bump of one scanner, or the pack list) may differ.
// 6. A held-out run is read by the loop: a test-split run is refused in a
//    comparison always, and its tables only print with its own release.
// 7. A location match on the same lines counts as preserved coverage of a
//    different issue: K1 compares items found with issue-level evidence,
//    and a candidate that only sits on a lost item's lines is named as a
//    location match, never as the item kept.
// Found by the OpenQodex review of this change:
// 8. A candidate the final answer raised and finalize hid reads as
//    unanswered, since the report lists hidden findings without their
//    candidate: the final answer is read, and a review that saved none is
//    named as missing it.
// 9. A language whose only language scanners did not run reads as a gap
//    with recall zero: a language scanner's remit counts toward the gap only
//    where it ran; where only a scanner that did not run holds an item, the
//    item's language remit is unknown.
// Found by the gpt-6.1-sol review of this change:
// 10. A merged finding takes the lines of the candidate it went into, so a
//    scanner is credited with an item only that candidate sat on, and the
//    scanner it merged into looks less unique: its own lines in the trail
//    are used, and the candidate's only where the trail lacks them.
// 11. A scanner an older scan names no status for, in a scan with no
//    selection, reads as one that looked and found nothing: a comparison
//    refuses it as a remit unknown.
// 12. A pin bump of one scanner lets another scanner's checksum or lock
//    file change ride along, since the versions alone are compared: the
//    toolchain records of both builds are read, checked against the hashes
//    the runs recorded, and compared entry by entry; only the named
//    scanner's entry and lock files may differ.
import { createHash } from "node:crypto";
import { langOf } from "../../packages/graph/dist/index.js";
import { DROP_CLASSES, classifyReportDrops, countDrops } from "./drops.mjs";
import { semgrepPacksOf } from "./external.mjs";
import { OWN_RULES, findersOf } from "./scan-score.mjs";
import { canonical, names, normPath, originOf, population } from "./score.mjs";

// Bump on any change to a definition above or a rule below.
export const SCANNERS_VERSION = 1;
// Scanners that take any file: their finds say nothing about a language.
export const GENERIC = Object.freeze(["semgrep", "gitleaks"]);
// A scanner with one of these statuses was handed files and did not look.
export const NOT_RUN = Object.freeze(["not_installed", "installing", "failed", "disabled", "untrusted"]);
export const DISPOSITIONS = Object.freeze(["raised", "held", "dropped", "unanswered", "unreviewed"]);
// A rule meets the default-off bar (P2 4.4 and 4.7, applied to one rule)
// when it has at least minKept kept candidates, at least dropShare of them
// dropped, from at least minRepos repositories (cases, on planted suites),
// and it found no truth item. Planted evidence alone is provisional.
export const RULE_OFF = Object.freeze({ minKept: 30, dropShare: 0.9, minRepos: 3 });
// A language is a gap (P2 4.7) with at least minItems reachable truth items
// (or minShare of the run's), when no language scanner has any in its file
// remit or the language scanners' recall on remit is under minRecall.
export const GAP = Object.freeze({ minItems: 10, minShare: 0.05, minRecall: 0.3 });
// What the change under test may differ in besides the product.
export const INPUT_CHANGES = "pin-bump:<scanner> or semgrep-packs";
// The clauses K2 to K4 of the keep rule are the acceptance rule's (the
// benchmark plan 4.11, scanner variant). Seam for P3-04: when this file
// lands, scanners.mjs --against hands it the paired runs after K1.
export const ACCEPTANCE_RULE = "benchmark/loop/decide.mjs";

const OWN_FINDERS = new Set(Object.values(OWN_RULES));
const isLanguageScanner = (name) => !GENERIC.includes(name) && !OWN_FINDERS.has(name);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const plus = (a, b) => ({ hit: a.hit + b.hit, of: a.of + b.of });

// The scanner and rule of a token "<source>:<ruleId>"; a custom scanner's
// source is "custom:<name>".
function tokenParts(token) {
  const t = String(token ?? "");
  const cut = t.indexOf(":", t.startsWith("custom:") ? "custom:".length : 0);
  return cut === -1 ? { source: t, ruleId: "" } : { source: t.slice(0, cut), ruleId: t.slice(cut + 1) };
}
const finderOfToken = (token) => findersOf(tokenParts(token))[0];

const span = (start, end) => [start, Math.max(end ?? start, start)];
const placesOfItem = (item) => [{ file: item.file, lines: item.lines }, ...(item.also ?? [])].filter((l) => Array.isArray(l.lines)).map((l) => ({ file: normPath(l.file), lines: l.lines }));
const overlaps = ([s, e], [a, b]) => s <= b && a <= e;
const onItem = (p, item) => placesOfItem(item).some((l) => l.file === p.file && overlaps([p.start, p.end], l.lines));
const expectedOf = (item) => item.found_by ?? item.expectedFinder ?? [];
const wordsOf = (item) => item.mentions ?? item.matchSignatures ?? [];

// Every place of a scan: each kept candidate, and each finding merged into
// a kept one at the lines the trail recorded for it. A merged token in
// alsoReportedBy that the trail does not hold (no trail, or a trail past its
// cap) is placed at its candidate's lines and counted in atCandidate.
function placesOf(scan) {
  const out = [];
  let atCandidate = 0;
  const kept = new Set((scan.candidates ?? []).map((c) => c.id));
  const merged = (token, file, start, end, into) => ({ kind: "merged", name: finderOfToken(token), token, file, start, end, text: tokenParts(token).ruleId.toLowerCase(), into });
  // The trail's merged entries by the candidate they went into and their token.
  const trailed = new Map();
  for (const e of scan.trail ?? []) {
    if (e.stage !== "merged" || !kept.has(e.into)) continue;
    const key = `${e.into}\0${e.token}`;
    trailed.set(key, [...(trailed.get(key) ?? []), e]);
  }
  for (const c of scan.candidates ?? []) {
    const [start, end] = span(c.lineStart, c.lineEnd);
    const file = normPath(c.filePath);
    out.push({ kind: "kept", name: findersOf(c)[0], token: c.token ?? `${c.source}:${c.ruleId}`, file, start, end, text: `${c.ruleId ?? ""}\n${c.message ?? ""}`.toLowerCase(), id: c.id });
    for (const t of c.alsoReportedBy ?? []) {
      const e = trailed.get(`${c.id}\0${t}`)?.shift();
      if (e) out.push(merged(t, normPath(e.file), ...span(e.lineStart, e.lineEnd), c.id));
      else {
        out.push(merged(t, file, start, end, c.id));
        atCandidate++;
      }
    }
  }
  // A merged entry no alsoReportedBy token names, at its own lines.
  for (const list of trailed.values()) for (const e of list) out.push(merged(e.token, normPath(e.file), ...span(e.lineStart, e.lineEnd), e.into));
  return { places: out, atCandidate };
}

// The truth item a place finds (rule S1), or the side issue it is.
function findOf(p, truth, extras) {
  const extra = extras.findIndex((x) => onItem(p, x) && names(x.mentions, p.text));
  if (extra !== -1) return { truth: null, extra };
  const hits = truth.map((item, order) => ({ item, order })).filter(({ item }) => onItem(p, item) && (expectedOf(item).includes(p.name) || names(wordsOf(item), p.text)));
  if (hits.length === 0) return { truth: null, extra: null };
  const gap = (item) => (normPath(item.file) === p.file && item.anchor ? Math.abs(p.start - item.anchor.line) : 0);
  hits.sort((a, b) => gap(a.item) - gap(b.item) || a.order - b.order);
  return { truth: hits[0].item.id, extra: null };
}

// Whether the change touched one of the item's lines: its own
// onChangedLines, else the case's changed lines (Map<path, Set<line>>, from
// the built case), else unknown (null).
function reachableOf(item, changed) {
  if (typeof item.onChangedLines === "boolean") return item.onChangedLines;
  if (!changed || item.side === "left") return null;
  return placesOfItem(item).some((l) => {
    const lines = changed.get(l.file);
    if (!lines) return false;
    for (let n = l.lines[0]; n <= l.lines[1]; n++) if (lines.has(n)) return true;
    return false;
  });
}

const extOf = (file) => {
  const base = file.split("/").pop() ?? file;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : base.toLowerCase();
  return ext === "yml" ? "yaml" : ext;
};
// The graph's language of a file, otherwise its extension (or its name).
export const languageOf = (file) => langOf(normPath(file)) ?? extOf(normPath(file));

// One sample analysed: `scan` its scan.json, `report` its report.json and
// `submission` its submission.json (null when it saved none), `row` its
// sample.json, `changed` the case's changed lines or null.
export function analyseSample({ job, spec, scan, report = null, submission = null, row = {}, mode = "review", changed = null }) {
  const truthItems = (spec?.bugs ?? []).filter((b) => b.valid !== false);
  const extras = spec?.extras ?? [];
  const { places, atCandidate } = placesOf(scan);
  const finds = places.map((p) => findOf(p, truthItems, extras));
  const selection = Array.isArray(scan.selection) ? new Map(scan.selection.map((s) => [s.scanner, new Set((s.paths ?? []).map(normPath))])) : null;
  const statuses = new Map((scan.scanners ?? []).map((s) => [s.scanner, s]));

  const truth = truthItems.map((item) => {
    const reachable = reachableOf(item, changed);
    const found = places.filter((p, i) => finds[i].truth === item.id);
    const remit = {};
    for (const [name, paths] of selection ?? []) {
      const inFile = placesOfItem(item).some((l) => paths.has(l.file));
      remit[name] = !inFile ? "out" : reachable === true ? "in" : reachable === false ? "unreachable" : "unknown";
    }
    const filterLosses = (scan.trail ?? [])
      .filter((e) => (e.stage === "changed-lines" || e.stage === "fixture") && onItem({ file: normPath(e.file), start: e.lineStart, end: Math.max(e.lineEnd ?? e.lineStart, e.lineStart) }, item))
      .map((e) => ({ scanner: finderOfToken(e.token), token: e.token, stage: e.stage }));
    return {
      id: item.id,
      file: normPath(item.file),
      class: item.class ?? null,
      language: languageOf(item.file),
      severity: item.severity ?? null,
      reachable,
      foundBy: [...new Set(found.map((p) => p.name))].sort(byText),
      foundTokens: [...new Set(found.map((p) => p.token))].sort(byText),
      locatedBy: [...new Set(places.filter((p) => onItem(p, item)).map((p) => p.name))].sort(byText),
      // Per scanner in the selection: in, out, unreachable or unknown; null with no selection.
      remit: selection === null ? null : remit,
      filterLosses,
    };
  });

  const reviewed = mode !== "scan" && report !== null;
  const shown = new Set([...(report?.findings ?? []), ...(report?.outside_change ?? [])].map((f) => f.candidate).filter((x) => typeof x === "string"));
  const answered = Array.isArray(submission?.findings) ? submission.findings : null;
  const held = new Set((answered ?? []).map((f) => f?.candidate).filter((x) => typeof x === "string" && !shown.has(x)));
  const drops = reviewed ? classifyReportDrops(report, scan) : [];
  const dropOf = new Map(drops.map((d) => [d.candidate?.id, d]));
  const candidates = (scan.candidates ?? []).map((c) => {
    const i = places.findIndex((p) => p.kind === "kept" && p.id === c.id);
    const p = places[i];
    const d = dropOf.get(c.id);
    const disposition = !reviewed ? "unreviewed" : shown.has(c.id) ? "raised" : held.has(c.id) ? "held" : d ? "dropped" : "unanswered";
    return {
      id: c.id,
      token: p.token,
      finder: p.name,
      absorbed: (c.alsoReportedBy ?? []).map(finderOfToken),
      disposition,
      drop: disposition === "dropped" ? { class: d.class, tags: d.tags } : null,
      finds: finds[i].truth,
      extra: finds[i].extra !== null,
      // On the lines of a truth item or of a side issue the spec lists.
      onTruth: [...truthItems, ...extras].some((item) => onItem(p, item)),
    };
  });

  const scanners = [...statuses.values()].map((s) => ({ name: s.scanner, status: s.status, version: s.version ?? null, raw: s.rawCount ?? null, kept: s.keptCount ?? null, ms: s.durationMs ?? null, resolveMs: s.resolveMs ?? null, files: s.files ?? null, stages: s.stages ?? null, rules: s.rules ?? null }));
  // A scanner the selection names that the scan left out (--only, --skip) did not look either.
  for (const name of selection?.keys() ?? []) if (!statuses.has(name)) scanners.push({ name, status: "left-out", version: null, raw: null, kept: null, ms: null, resolveMs: null, files: null, stages: null, rules: null });
  // What dedup merged, by token: the trail's merged entries, or before the
  // trail, the tokens in alsoReportedBy (the same findings).
  const mergedTokens = {};
  const mergedList = Array.isArray(scan.trail) ? scan.trail.filter((e) => e.stage === "merged").map((e) => e.token) : (scan.candidates ?? []).flatMap((c) => c.alsoReportedBy ?? []);
  for (const token of mergedList) mergedTokens[token] = (mergedTokens[token] ?? 0) + 1;

  const ran = scanners.filter((s) => s.status === "ran" && typeof s.ms === "number");
  const slowestMs = ran.length === 0 ? null : Math.max(...ran.map((s) => s.ms));
  const t = report?.timings ?? null;
  const num = (...xs) => xs.find((x) => typeof x === "number" && Number.isFinite(x)) ?? null;
  const wallMs = num(t?.total_ms, row.wallMs);
  const reviewerMs = mode === "scan" ? 0 : num(t?.reviewer_ms, row.reviewerMs, report?.completion?.reviewer?.duration_ms);
  const graphMs = num(t?.graph_ms, row.graphMs, mode === "scan" ? 0 : null);
  const scanMs = num(t?.scan_ms);
  const stage = scanMs ?? slowestMs;
  return {
    jobId: job.jobId,
    caseId: job.caseId,
    case: job.case,
    config: job.config,
    repeat: job.repeat,
    sample: `${job.case}/${job.config}/${job.repeat}`,
    repoGroup: spec?.repoGroup ?? job.case,
    has: { submission: !reviewed || answered !== null, selection: selection !== null, trail: Array.isArray(scan.trail), stages: ran.every((s) => s.stages !== null), resolveMs: ran.every((s) => s.resolveMs !== null), files: ran.every((s) => s.files !== null), timings: t !== null },
    scanners,
    mergedTokens,
    mergedAtCandidateLines: atCandidate,
    candidates,
    drops,
    truth,
    time: {
      wallMs,
      reviewerMs,
      graphMs,
      scanMs,
      slowestMs,
      slowest: slowestMs === null ? [] : ran.filter((s) => s.ms === slowestMs).map((s) => s.name).sort(byText),
      restMs: wallMs !== null && reviewerMs !== null && graphMs !== null && stage !== null ? wallMs - reviewerMs - graphMs - stage : null,
      stageOverSlowest: scanMs !== null && slowestMs ? scanMs / slowestMs : null,
    },
  };
}

// A run's first attempts analysed. `attempts` are as score.mjs loadRun reads
// them ({ case, config, repeat, attempt, row, report, submission, scan }), `specs` the
// specs by case name, and `changedOf(case)` the case's changed lines or
// null. A planned job whose first attempt saved no scan.json is listed in
// noScan and analysed no further.
export function analyseRun({ name, manifest, attempts, specs, changedOf = () => null, toolchain = null }) {
  const suite = manifest.suite ?? "planted";
  if (originOf(suite) === null) throw new Error(`the run names the suite ${suite}, which the scorer does not know`);
  const pop = population(manifest, attempts);
  if (pop.problems.length > 0) throw new Error(`the run's samples do not match its plan:\n${pop.problems.join("\n")}`);
  const mode = manifest.mode ?? "review";
  const samples = [];
  const noScan = [];
  const scans = [];
  for (const j of pop.jobs) {
    if (!j.first?.scan) {
      noScan.push({ jobId: j.jobId, why: j.first ? "it saved no scan.json" : "it never started" });
      continue;
    }
    scans.push(j.first.scan);
    samples.push(analyseSample({ job: j, spec: specs[j.case], scan: j.first.scan, report: j.first.report ?? null, submission: j.first.submission ?? null, row: j.first.row ?? {}, mode, changed: changedOf(j.case) }));
  }
  return {
    name,
    suite,
    split: manifest.split ?? "dev",
    splitHash: manifest.splitHash ?? null,
    release: manifest.release ?? null,
    mode,
    external: manifest.external ?? null,
    // The packs the run recorded, else what its scans recorded (lib/external.mjs).
    semgrepPacks: manifest.external?.semgrepPacks ?? semgrepPacksOf(scans),
    // The build's toolchain record (toolchainRecord), or { error }, or null when not read.
    toolchain,
    planned: pop.jobs.length,
    samples,
    noScan,
  };
}

// Why a run's tables may not be printed: a held-out run outside its release.
export function runRefusals(run, { release = null } = {}) {
  if (run.split !== "test") return [];
  if (release !== null && release === run.release) return [];
  return [`${run.name} is from the test split: the scanner tables of a held-out run are read only at its release (--release ${run.release ?? "<its release>"})`];
}

// A distribution with its count: median (the mean of the middle two), the
// nearest-rank 90th percentile, the largest.
export function dist(xs) {
  const v = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, p50: null, p90: null, max: null };
  const mid = Math.floor(v.length / 2);
  return { n: v.length, p50: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2, p90: v[Math.ceil(0.9 * v.length) - 1], max: v[v.length - 1] };
}

// The fields an older scan did not record, each with how many samples lack it.
function missingOf(samples) {
  const fields = [
    ["selection", (s) => s.has.selection],
    ["trail", (s) => s.has.trail],
    ["stages", (s) => s.has.stages],
    ["resolveMs", (s) => s.has.resolveMs],
    ["files", (s) => s.has.files],
    ["timings", (s) => s.has.timings],
    ["submission", (s) => s.has.submission],
  ];
  const out = {};
  for (const [field, has] of fields) {
    const lacking = samples.filter((s) => !has(s)).length;
    if (lacking > 0) out[field] = { lacking, of: samples.length };
  }
  return out;
}

const emptyScanner = () => ({
  samples: { ran: 0, noFiles: 0, notRun: {}, own: 0 },
  versions: [],
  raw: 0,
  removed: { changedLines: 0, fixtures: 0, rules: 0, merged: 0 },
  removedRecorded: true,
  kept: 0,
  mergedAway: 0,
  raised: 0,
  held: 0,
  dropped: 0,
  unanswered: 0,
  unreviewed: 0,
  dropsByClass: Object.fromEntries(DROP_CLASSES.map((k) => [k, 0])),
  found: 0,
  unique: 0,
  located: 0,
  precision: { hit: 0, of: 0 },
  locationPrecision: { hit: 0, of: 0 },
  raisedPrecision: { hit: 0, of: 0 },
  remit: { hit: 0, of: 0, unknown: 0 },
  infraMisses: 0,
  infraUnknown: 0,
  msList: [],
  resolveList: [],
  slowestIn: 0,
  lost: new Map(),
  candidatesSaved: 0,
});

// The scanners.json body of an analysed run: the scanner, rule, drop, gap,
// time and leave-one-out tables, the misses, and what the scans did not
// record.
export function scannerReport(run) {
  const S = new Map();
  const row = (name) => {
    if (!S.has(name)) S.set(name, emptyScanner());
    return S.get(name);
  };
  const rules = new Map();
  const rule = (token) => {
    if (!rules.has(token)) rules.set(token, { token, scanner: finderOfToken(token), kept: 0, merged: 0, raised: 0, held: 0, dropped: 0, unanswered: 0, dropsByClass: Object.fromEntries(DROP_CLASSES.map((k) => [k, 0])), found: 0, unique: 0, repos: new Set() });
    return rules.get(token);
  };
  const misses = [];
  const filterLosses = [];
  const allDrops = [];
  const items = new Map();
  const totals = { samples: run.samples.length, candidates: 0, raised: 0, held: 0, dropped: 0, unanswered: 0, unreviewed: 0 };

  for (const s of run.samples) {
    allDrops.push(...s.drops);
    for (const sc of s.scanners) {
      const r = row(sc.name);
      if (sc.version && !r.versions.includes(sc.version)) r.versions.push(sc.version);
      if (sc.status === "ran") {
        r.samples.ran++;
        r.raw += sc.raw ?? 0;
        if (sc.stages) for (const k of Object.keys(r.removed)) r.removed[k] += sc.stages[k] ?? 0;
        else r.removedRecorded = false;
        r.msList.push(sc.ms);
        r.resolveList.push(sc.resolveMs);
        if (s.time.slowest.includes(sc.name)) r.slowestIn++;
      } else if (sc.status === "no_matching_files") r.samples.noFiles++;
      else r.samples.notRun[sc.status] = (r.samples.notRun[sc.status] ?? 0) + 1;
    }
    for (const [token, n] of Object.entries(s.mergedTokens)) {
      row(finderOfToken(token)).mergedAway += n;
      rule(token).merged += n;
    }
    for (const c of s.candidates) {
      const r = row(c.finder);
      const x = rule(c.token);
      totals.candidates++;
      totals[c.disposition]++;
      r.kept++;
      r[c.disposition]++;
      x.kept++;
      x.repos.add(s.repoGroup);
      if (c.disposition !== "unreviewed") x[c.disposition]++;
      if (c.drop) {
        r.dropsByClass[c.drop.class]++;
        x.dropsByClass[c.drop.class]++;
      }
      const finds = c.finds !== null || c.extra;
      r.precision = plus(r.precision, { hit: finds ? 1 : 0, of: 1 });
      r.locationPrecision = plus(r.locationPrecision, { hit: c.onTruth ? 1 : 0, of: 1 });
      r.raisedPrecision = plus(r.raisedPrecision, { hit: finds && c.disposition === "raised" ? 1 : 0, of: 1 });
      if (!c.absorbed.some((f) => f !== c.finder)) r.candidatesSaved++;
    }
    const statusOf = new Map(s.scanners.map((sc) => [sc.name, sc.status]));
    for (const t of s.truth) {
      for (const name of t.foundBy) row(name).found++;
      for (const name of t.locatedBy) row(name).located++;
      for (const token of t.foundTokens) rule(token).found++;
      if (t.foundTokens.length === 1) rule(t.foundTokens[0]).unique++;
      if (t.foundBy.length === 1) {
        const r = row(t.foundBy[0]);
        r.unique++;
        const key = `${s.caseId}\0${t.id}`;
        r.lost.set(key, (r.lost.get(key) ?? 0) + 1);
      }
      for (const loss of t.filterLosses) filterLosses.push({ sample: s.sample, caseId: s.caseId, truth: t.id, ...loss });
      // The remit of every scanner the scan names: from the selection, else
      // unknown. A scanner the runner says had no matching files was handed
      // none, so nothing is in its file remit.
      for (const [name, status] of statusOf) {
        if (OWN_FINDERS.has(name) || status === "no_matching_files") continue;
        const state = t.remit === null ? "unknown" : (t.remit[name] ?? "out");
        if (state === "out" || state === "unreachable") continue;
        const r = row(name);
        const looked = status === "ran" || status === "no_matching_files";
        if (state === "unknown") {
          if (looked) r.remit.unknown++;
          else r.infraUnknown++;
          continue;
        }
        if (!looked) {
          r.infraMisses++;
          continue;
        }
        const found = t.foundBy.includes(name);
        r.remit = { ...plus(r.remit, { hit: found ? 1 : 0, of: 1 }), unknown: r.remit.unknown };
        if (!found) misses.push({ sample: s.sample, caseId: s.caseId, truth: t.id, scanner: name, class: t.class, file: t.file });
      }
      const key = `${s.caseId}\0${t.id}`;
      const it = items.get(key) ?? { caseId: s.caseId, truth: t.id, language: t.language, class: t.class, reachable: [], found: false, foundLanguage: false, inLanguageRemit: [] };
      it.reachable.push(t.reachable);
      it.found ||= t.foundBy.length > 0;
      it.foundLanguage ||= t.foundBy.some(isLanguageScanner);
      // Only a language scanner that ran puts the item in a language remit; one that did not run leaves it unknown.
      const languageScanners = t.remit === null ? null : Object.entries(t.remit).filter(([name]) => isLanguageScanner(name)).map(([name, state]) => ({ state, ran: statusOf.get(name) === "ran" }));
      it.inLanguageRemit.push(languageScanners === null ? null : languageScanners.some((x) => x.ran && x.state === "in") ? true : languageScanners.some((x) => x.state === "unknown" || x.state === "in") ? null : false);
      items.set(key, it);
    }
  }

  const scanners = {};
  for (const name of [...S.keys()].sort(byText)) {
    const r = S.get(name);
    scanners[name] = {
      samples: r.samples,
      versions: r.versions.sort(byText),
      raw: r.raw,
      // What each filter stage removed, summed where the scanner ran; null
      // when it never ran or a scan it ran in did not record its stages.
      removed: r.samples.ran > 0 && r.removedRecorded ? r.removed : null,
      kept: r.kept,
      mergedAway: r.mergedAway,
      raised: r.raised,
      held: r.held,
      dropped: r.dropped,
      unanswered: r.unanswered,
      unreviewed: r.unreviewed,
      dropsByClass: r.dropsByClass,
      found: r.found,
      unique: r.unique,
      located: r.located,
      precision: r.precision,
      locationPrecision: r.locationPrecision,
      raisedPrecision: r.raisedPrecision,
      remit: r.remit,
      infraMisses: r.infraUnknown > 0 ? null : r.infraMisses,
      infraUnknown: r.infraUnknown,
      ms: dist(r.msList),
      resolveMs: dist(r.resolveList),
      slowestIn: r.slowestIn,
      leaveOneOut: {
        lost: [...r.lost].map(([key, samples]) => ({ caseId: key.split("\0")[0], truth: key.split("\0")[1], samples })).sort((a, b) => byText(a.caseId, b.caseId) || byText(a.truth, b.truth)),
        candidatesSaved: r.candidatesSaved,
      },
    };
  }

  const ruleRows = [...rules.values()]
    .map((x) => {
      const repos = x.repos.size;
      const defaultOff = x.kept >= RULE_OFF.minKept && x.dropped >= RULE_OFF.dropShare * x.kept && repos >= RULE_OFF.minRepos && x.found === 0;
      return { ...x, repos, defaultOff };
    })
    .sort((a, b) => b.kept - a.kept || byText(a.token, b.token));

  const drops = countDrops(allDrops);
  drops.ruleFpReasons = allDrops.filter((d) => d.class === "rule-fp").slice(0, 5).map((d) => ({ token: d.candidate?.token ?? "unknown", reason: String(d.reason ?? "").replace(/\s+/g, " ").trim() }));

  const { gaps, languages } = gapsOf([...items.values()]);
  const samples = run.samples;
  const sum = (f) => samples.reduce((a, s) => a + (f(s) ?? 0), 0);
  const withBoth = samples.filter((s) => s.time.wallMs !== null && s.time.reviewerMs !== null);
  const over = samples.filter((s) => s.time.stageOverSlowest !== null);
  const slowest = {};
  for (const s of samples) for (const name of s.time.slowest) slowest[name] = (slowest[name] ?? 0) + 1;
  const time = {
    samples: samples.length,
    wallMs: dist(samples.map((s) => s.time.wallMs)),
    reviewerMs: dist(samples.map((s) => s.time.reviewerMs)),
    reviewerShare: { hit: withBoth.reduce((a, s) => a + s.time.reviewerMs, 0), of: withBoth.reduce((a, s) => a + s.time.wallMs, 0) },
    slowestScannerMs: dist(samples.map((s) => s.time.slowestMs)),
    scanMs: dist(samples.map((s) => s.time.scanMs)),
    graphMs: dist(samples.map((s) => s.time.graphMs)),
    restMs: dist(samples.map((s) => s.time.restMs)),
    restFrom: samples.every((s) => s.time.scanMs !== null) ? "scan_ms" : "the slowest scanner",
    candidatesPerSample: { candidates: sum((s) => s.candidates.length), samples: samples.length },
    stageOverSlowest: over.length === 0 ? null : { ...dist(over.map((s) => s.time.stageOverSlowest)), over115: over.filter((s) => s.time.stageOverSlowest > 1.15).length },
    slowest: Object.fromEntries(Object.entries(slowest).sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))),
  };

  return {
    version: SCANNERS_VERSION,
    run: run.name,
    suite: run.suite,
    split: run.split,
    mode: run.mode,
    toolchainHash: run.external?.toolchainHash ?? null,
    semgrepRules: run.semgrepPacks,
    missingFields: Object.keys(missingOf(samples)),
    missing: missingOf(samples),
    classRemit: "unlearned: the remit is the file remit (pooled baselines, --pool, are not read yet)",
    population: { planned: run.planned, scanned: samples.length, noScan: run.noScan },
    totals,
    scanners,
    rules: ruleRows,
    drops,
    gaps,
    languages,
    time,
    misses,
    filterLosses,
    // Merged findings placed at their candidate's lines, since the trail did not record their own.
    mergedAtCandidateLines: run.samples.reduce((a, x) => a + x.mergedAtCandidateLines, 0),
  };
}

// Per language and class, over distinct truth items (a case's item counts
// once, found when any sample found it): how many, how many reachable,
// found by a language scanner, by semgrep or gitleaks only, by none, and in
// a language scanner's file remit. Then each language's gap verdict.
function gapsOf(items) {
  const known = (xs) => (xs.some((x) => x === true) ? true : xs.every((x) => x === false) ? false : null);
  const rows = new Map();
  const langs = new Map();
  const count = (n, v) => (n === null || v === null ? null : n + (v ? 1 : 0));
  for (const it of items) {
    const reachable = known(it.reachable);
    const inRemit = known(it.inLanguageRemit);
    const key = `${it.language}\0${it.class ?? "unclassed"}`;
    const r = rows.get(key) ?? { language: it.language, class: it.class ?? "unclassed", items: 0, reachable: 0, foundLanguageScanner: 0, foundGenericOnly: 0, foundNone: 0, inLanguageRemit: 0 };
    r.items++;
    r.reachable = count(r.reachable, reachable);
    if (it.foundLanguage) r.foundLanguageScanner++;
    else if (it.found) r.foundGenericOnly++;
    else r.foundNone++;
    r.inLanguageRemit = count(r.inLanguageRemit, inRemit);
    rows.set(key, r);
    const l = langs.get(it.language) ?? { language: it.language, items: 0, reachable: 0, inLanguageRemit: 0, languageRecall: { hit: 0, of: 0 }, unknown: false };
    l.items++;
    l.reachable = count(l.reachable, reachable);
    l.inLanguageRemit = count(l.inLanguageRemit, inRemit);
    if (inRemit === true) l.languageRecall = plus(l.languageRecall, { hit: it.foundLanguage ? 1 : 0, of: 1 });
    langs.set(it.language, l);
  }
  const total = items.length;
  const languages = [...langs.values()]
    .map((l) => {
      let gap = null;
      let why;
      if (l.reachable === null || l.inLanguageRemit === null) why = "unknown: the scans recorded no selection, or the changed lines are not known";
      else if (l.reachable < GAP.minItems && l.reachable < GAP.minShare * total) {
        gap = false;
        why = `${l.reachable} reachable items, under ${GAP.minItems} and under ${Math.round(GAP.minShare * 100)}% of the run's`;
      } else if (l.inLanguageRemit === 0) {
        gap = true;
        why = "no language scanner has any item in its file remit";
      } else if (l.languageRecall.hit < GAP.minRecall * l.languageRecall.of) {
        gap = true;
        why = `language scanners found ${l.languageRecall.hit} of ${l.languageRecall.of} items in their remit, under ${Math.round(GAP.minRecall * 100)}%`;
      } else {
        gap = false;
        why = `language scanners found ${l.languageRecall.hit} of ${l.languageRecall.of} items in their remit`;
      }
      return { language: l.language, items: l.items, reachable: l.reachable, inLanguageRemit: l.inLanguageRemit, languageRecall: l.languageRecall, gap, why };
    })
    .sort((a, b) => byText(a.language, b.language));
  const gaps = [...rows.values()].sort((a, b) => byText(a.language, b.language) || byText(a.class, b.class));
  return { gaps, languages };
}

// The truth items each case's samples found, and what sat on their lines.
function foundByCase(run) {
  const out = new Map();
  for (const s of run.samples) {
    const c = out.get(s.caseId) ?? { samples: 0, items: new Map() };
    c.samples++;
    for (const t of s.truth) {
      const x = c.items.get(t.id) ?? { foundIn: 0, foundBy: new Set(), locatedBy: new Set() };
      if (t.foundBy.length > 0) x.foundIn++;
      for (const n of t.foundBy) x.foundBy.add(n);
      for (const n of t.locatedBy) x.locatedBy.add(n);
      c.items.set(t.id, x);
    }
    out.set(s.caseId, c);
  }
  return out;
}

// Why a run's scanners cannot be judged: a scanner that did not run where
// truth lies, or may lie, in its remit, and a scanner of `expected` (every
// scanner either run names) that a scan with no selection names no status
// for. One line per scanner, status and reason, naming the samples' cases.
function notRunRefusals(run, expected = []) {
  const groups = new Map();
  const add = (sc, kind, s, ids) => {
    const key = `${sc.name}\0${sc.status}\0${kind}`;
    const g = groups.get(key) ?? { name: sc.name, status: sc.status, kind, samples: 0, cases: new Set(), ids: new Set() };
    g.samples++;
    g.cases.add(s.case);
    for (const id of ids) g.ids.add(`${s.case} ${id}`);
    groups.set(key, g);
  };
  for (const s of run.samples) {
    if (!s.has.selection && s.truth.length > 0) {
      const named = new Set(s.scanners.map((sc) => sc.name));
      for (const name of expected) if (!named.has(name) && !OWN_FINDERS.has(name)) add({ name, status: "no status" }, "no-status", s, []);
    }
    for (const sc of s.scanners) {
      if (!NOT_RUN.includes(sc.status) && sc.status !== "left-out") continue;
      if (OWN_FINDERS.has(sc.name) || s.truth.length === 0) continue;
      if (s.truth.some((t) => t.remit === null)) {
        add(sc, "no-selection", s, []);
        continue;
      }
      const inRemit = s.truth.filter((t) => t.remit[sc.name] === "in").map((t) => t.id);
      const maybe = s.truth.filter((t) => t.remit[sc.name] === "unknown").map((t) => t.id);
      if (inRemit.length > 0) add(sc, "in-remit", s, inRemit);
      else if (maybe.length > 0) add(sc, "maybe", s, maybe);
    }
  }
  return [...groups.values()].map((g) => {
    if (g.kind === "no-status") return `${g.name} has no status in ${g.samples} sample${g.samples === 1 ? "" : "s"} of ${run.name} (${[...g.cases].sort(byText).join(", ")}); those scans recorded no selection, so its remit is unknown and truth may lie in it`;
    const head = `${g.name} did not run (${g.status}) in ${g.samples} sample${g.samples === 1 ? "" : "s"} of ${run.name} (${[...g.cases].sort(byText).join(", ")})`;
    const ids = [...g.ids].sort(byText).join(", ");
    if (g.kind === "no-selection") return `${head}; those scans recorded no selection, so its remit is unknown and truth may lie in it`;
    if (g.kind === "in-remit") return `${head}, and truth lies in its remit: ${ids}`;
    return `${head}; ${ids} sit in its files on lines not known to be changed`;
  });
}

// A scanner toolchain record from the bytes toolchainHash() reads
// (packages/scanners/src/toolchain/table.ts): the pinned table and each
// lock file. `hash` is the sha256 toolchainHash() gives for them, `tools`
// each tool's entry as canonical JSON, `locks` each lock file's sha256.
export function toolchainRecord({ table, locks = [] }) {
  const sorted = [...locks].sort((a, b) => byText(a.name, b.name));
  const hash = createHash("sha256").update(table);
  for (const l of sorted) hash.update(`\0${l.name}\0`).update(l.bytes);
  const parsed = JSON.parse(String(table));
  return {
    hash: hash.digest("hex"),
    schema: parsed.schema ?? null,
    tools: Object.fromEntries(Object.entries(parsed.tools ?? {}).map(([k, v]) => [k, canonical(v)])),
    locks: Object.fromEntries(sorted.map((l) => [l.name, createHash("sha256").update(l.bytes).digest("hex")])),
  };
}

// The tool a lock file pins: "kube-linter-linux-x64.txt" is kube-linter's.
const lockTool = (file) => file.replace(/-(?:darwin|linux|win32|windows)-[a-z0-9]+\.txt$/, "").replace(/\.txt$/, "");

// Every entry two toolchain records differ in: { tool, what }, sorted, with
// tool null for the table's own fields.
function toolchainDifferences(a, b) {
  const out = [];
  if (a.schema !== b.schema) out.push({ tool: null, what: `the table's schema ${a.schema} then ${b.schema}` });
  for (const tool of [...new Set([...Object.keys(a.tools), ...Object.keys(b.tools)])].sort(byText)) if (a.tools[tool] !== b.tools[tool]) out.push({ tool, what: `${tool} entry` });
  for (const lock of [...new Set([...Object.keys(a.locks), ...Object.keys(b.locks)])].sort(byText)) if (a.locks[lock] !== b.locks[lock]) out.push({ tool: lockTool(lock), what: `${lockTool(lock)} lock file ${lock}` });
  return out;
}

// Why a pin bump of `bump` cannot be allowed: a record not read or not the
// one the run hashed, or an entry beyond the bumped scanner's.
function pinBumpRefusals(base, cand, bump) {
  const unchecked = [base, cand].flatMap((r) => {
    const rec = r.toolchain;
    if (!rec) return [`${r.name}: its build's toolchain record was not read`];
    if (rec.error) return [`${r.name}: ${rec.error}`];
    if (rec.hash !== r.external.toolchainHash) return [`${r.name}: its build's toolchain record hashes to ${rec.hash.slice(0, 12)}, not the ${String(r.external.toolchainHash).slice(0, 12)} the run recorded`];
    return [];
  });
  if (unchecked.length > 0) return [`the pin bump of ${bump} cannot be checked entry by entry: ${unchecked.join("; ")}`];
  const diff = toolchainDifferences(base.toolchain, cand.toolchain);
  const beyond = diff.filter((d) => d.tool !== bump);
  if (beyond.length > 0) return [`the scanner toolchain differs beyond the pin bump of ${bump}: ${beyond.map((d) => d.what).join(", ")}`];
  if (diff.length === 0) return [`--input-change pin-bump:${bump} names a pin bump, but ${bump}'s toolchain entry and lock files are the same in both builds`];
  return [];
}

const describePacks = (p) => (Array.isArray(p) ? (p.length === 0 ? "none" : p.map((x) => `${x.pack} ${String(x.sha256).slice(0, 12)}`).join(", ")) : String(p));

// Why the inputs of two runs differ beyond the change under test.
function inputRefusals(base, cand, change) {
  const out = [];
  const bump = /^pin-bump:(.+)$/.exec(change ?? "")?.[1] ?? null;
  if (change !== null && bump === null && change !== "semgrep-packs") return [`--input-change takes ${INPUT_CHANGES}, not ${change}`];
  for (const r of [base, cand]) if (r.semgrepPacks === "unknown" || r.semgrepPacks === "mixed") out.push(`the Semgrep rule packs of ${r.name} are ${r.semgrepPacks}, so a rule change cannot be told from a product change`);
  if (out.length === 0) {
    const differ = JSON.stringify(base.semgrepPacks) !== JSON.stringify(cand.semgrepPacks);
    if (differ && change !== "semgrep-packs") out.push(`the Semgrep rule packs differ: ${describePacks(base.semgrepPacks)}, then ${describePacks(cand.semgrepPacks)}; name the pack change under test with --input-change semgrep-packs`);
    if (!differ && change === "semgrep-packs") out.push("--input-change semgrep-packs names a pack change, but both runs read the same packs");
  }
  const a = base.external;
  const b = cand.external;
  if (!a?.toolchainHash || !b?.toolchainHash) {
    for (const [r, x] of [[base, a], [cand, b]]) if (!x?.toolchainHash) out.push(`the scanner toolchain of ${r.name} is not recorded (manifest external), so a toolchain change cannot be told from a product change`);
    return out;
  }
  const names = [...new Set([...Object.keys(a.scannerVersions ?? {}), ...Object.keys(b.scannerVersions ?? {})])].sort(byText);
  const moved = names.filter((n) => a.scannerVersions?.[n] !== b.scannerVersions?.[n]);
  if (a.toolchainHash !== b.toolchainHash) {
    const what = moved.length === 0 ? "no scanner version" : moved.map((n) => `${n} ${a.scannerVersions?.[n] ?? "none"} then ${b.scannerVersions?.[n] ?? "none"}`).join(", ");
    if (bump === null) out.push(`the scanner toolchain differs (${what}); name the one pin bump under test with --input-change pin-bump:<scanner>`);
    else if (moved.some((n) => n !== bump)) out.push(`the scanner toolchain differs beyond the pin bump of ${bump}: ${what}`);
    else out.push(...pinBumpRefusals(base, cand, bump));
  } else if (bump !== null) out.push(`--input-change pin-bump:${bump} names a pin bump, but both runs ran the same toolchain`);
  return out;
}

// K1 of the scanner keep rule (the benchmark plan 4.11, scanner variant)
// for a candidate run against its baseline, or the reasons it cannot be
// judged. Exit 0 when K1 holds, 1 when it fails, 2 when refused. K2 to K4
// are the acceptance rule's (ACCEPTANCE_RULE).
export function judgeAgainst(base, cand, { inputChange = null } = {}) {
  const refusals = [];
  for (const [label, r] of [["baseline", base], ["candidate", cand]]) if (r.split === "test") refusals.push(`the ${label} ${r.name} is from the test split: the scanner loop never reads a held-out run`);
  for (const [what, a, b] of [["suite", base.suite, cand.suite], ["mode", base.mode, cand.mode], ["split hash", base.splitHash, cand.splitHash]]) if (a !== b) refusals.push(`the runs differ in ${what}: ${a} then ${b}`);
  refusals.push(...inputRefusals(base, cand, inputChange));
  // Every scanner either run names, in a scan or as a pinned version.
  const expected = [...new Set([base, cand].flatMap((r) => [...r.samples.flatMap((x) => x.scanners.map((sc) => sc.name)), ...Object.keys(r.external?.scannerVersions ?? {})]))].sort(byText);
  for (const r of [base, cand]) {
    refusals.push(...notRunRefusals(r, expected));
    for (const j of r.noScan) refusals.push(`${r.name} ${j.jobId}: ${j.why}, so its truth cannot be judged`);
  }
  const before = foundByCase(base);
  const after = foundByCase(cand);
  for (const caseId of before.keys()) if (!after.has(caseId)) refusals.push(`${cand.name} has no scan of ${caseId}, which ${base.name} holds`);
  if (refusals.length > 0) return { exit: 2, refusals, k1: null };

  const lost = [];
  let checked = 0;
  for (const [caseId, b] of [...before].sort((x, y) => byText(x[0], y[0]))) {
    const a = after.get(caseId);
    for (const [truth, x] of [...b.items].sort((p, q) => byText(p[0], q[0]))) {
      if (x.foundIn === 0) continue;
      checked++;
      const now = a.items.get(truth);
      if (now && now.foundIn === a.samples) continue;
      lost.push({ caseId, truth, foundBefore: [...x.foundBy].sort(byText), locatedNow: [...(now?.locatedBy ?? [])].sort(byText) });
    }
  }
  return { exit: lost.length > 0 ? 1 : 0, refusals: [], k1: { pass: lost.length === 0, lost, checked } };
}
