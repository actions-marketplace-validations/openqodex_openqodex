#!/usr/bin/env node
// The review queue: findings that no frozen spec decides, waiting for a
// person to rule on them.
//
//   node benchmark/queue.mjs add <run folder | unresolved file> [--queue <folder>]
//   node benchmark/queue.mjs add --candidates <run folder> [--specs <folder>] [--queue <folder>]
//   node benchmark/queue.mjs sheet <suite> [--seed <n>] [--json] [--queue <folder>]
//   node benchmark/queue.mjs decide <status> <target>... --by <your name>
//        [--bug <truth id>] [--run <run folder> [--specs <folder>]]
//        [--note <text>] [--sheet <sheet id>] [--queue <folder>]
//
// add merges a scored run's unresolved.jsonl (score.mjs writes it) into
// <queue>/<suite>.jsonl, one item per finding, and drops every question the
// rulings already answer. add --candidates merges the run's scanner
// candidates that no review raised and nothing frozen decides (every one of
// a scanner-only run, each a review dropped; lib/queue.mjs candidateItems),
// with the code at their lines from the case built from the live tree when
// the run's case hash is the live one; --specs scores the run against other
// specs, as in score.mjs. A candidate is ruled like a finding, by the ref
// the sheet prints. sheet prints the open items blind: the case, the
// finding, the code and the truth item, in a seeded shuffle, with no run,
// build, configuration or count. decide appends one ruling to
// <queue>/decisions.jsonl, the adjudication file (lib/rulings.mjs), which
// score.mjs reads. The queue folder is benchmark/review-queue unless
// --queue names another.
//
// decide's statuses and targets:
//   true | false <ref>                         the finding is a real issue the truth does not list, or not
//   true | false <case id>#I<n>                the same for an issue a person consolidated
//     (spec-candidate-accepted and spec-candidate-rejected are true and false)
//   same-issue | different-issue <ref>         the finding is, or is not, the truth item it sits on
//   same-issue <ref> --bug <id>                the finding is truth item <id> of its own file, found at
//                                              a place the spec does not list
//   consolidate <ref> <ref>...                 these findings of one case are one issue in different words
//   confirmed | disputed <case id> --bug <id> --run <run folder> [--specs <folder>]
//                                              a truth item of the case, as the spec the run is scored
//                                              against writes it (its own cases/ copy, or the folder
//                                              --specs names), is right, or wrong
//   clean | not-clean <case id>                a candidate clean control has no issue, or has one
//     (on a clean/ candidate, --sheet clean@<seed>@<version> as the clean sheet prints it)
// <ref> is the start of a findingId, 8 hex or more, as the sheet prints it.
// A ruling on a truth item (same-issue, different-issue, confirmed,
// disputed) records the version of the spec it judged, and counts only
// where a run is scored against that version (lib/rulings.mjs).
// --by names the person who made the ruling, as people.json in the queue
// folder lists them. A model or an agent never rules: the session may draft
// rulings, and a person records them.
//
// Exit codes: 0 done; 2 refused, with nothing written.
//
// Failure list, written before the code (the queue's own is in lib/queue.mjs):
// 1. A ruling is written without a person's name, or under a model's or an
//    agent's: decide refuses before it writes anything.
// 2. A ref that matches two findings puts the ruling on the wrong one: a ref
//    must match exactly one known finding.
// 3. A consolidate line groups findings of two cases, or a single finding:
//    refused.
// 4. A ruling on an issue no person consolidated: refused.
// 5. A same-issue ruling names a truth item the finding does not sit on:
//    the truth item is the one the queue item names, unless --bug names
//    another of the same spec version, in the finding's own file, and the
//    finding sits on a line the change added there (issue 139: a planted
//    bug found where it bites, away from its listed lines). Any other
//    truth item, file or line is refused, and --bug on a status that takes
//    no truth item is refused rather than ignored.
// 6. The blind sheet shows the run, the build, the configuration, the arm or
//    how often a finding recurred, or its order cannot be drawn again: it
//    carries the case, the finding, the code and the truth item only, every
//    text through the shared redactor (lib/drops.mjs) fed with every run,
//    build (its full commit and its short form) and configuration the items
//    were seen in, in a seeded shuffle (lib/drops.mjs drawAudit) whose seed
//    it prints.
// 7. A held-out run's findings enter the committed queue: add refuses items
//    from a test split.
// 8. A crash halfway through add leaves half a queue: the new file is
//    written beside the old and renamed over it.
// 9. A ruling on a truth item reaches another version of its case (issue
//    163): a match ruling takes the spec version from its queue item, and a
//    bug ruling from the run it names with --run (the case's spec in the
//    run's cases/, or in the folder --specs names), after checking the run
//    scored that case and the spec lists that item. A queue item from
//    before the spec version was recorded is refused until its run is added
//    again.
// 10. A bug ruling is recorded against a held-out spec version: --run
//    refuses a run of the test split, of a suite whose every case is held
//    out, or of a case the committed split holds out, before any spec is
//    read, --specs or not (add refuses held-out items the same way, 7).
// 11. A sheet item for a scanner candidate redacts its own words: the
//    configuration of a scanner-only run ("scan") names no arm, so it is
//    not fed to the redactor.
// 12. A case name from a run's manifest leads a build and a git command
//    outside the temp folder ("../../somewhere"): add --candidates refuses
//    a planted run that names anything but a planted case name before any
//    path is built, and the build path must stay inside the temp folder.
//    No candidate's file path reaches git or a file read: the code at its
//    lines is looked up in the parsed diff by key.
// 13. A ruling on a clean candidate admits it after its evidence moved: a
//    clean or not-clean ruling on a clean/ case names the sheet it was made
//    on, which must show the current version of the candidates
//    (ingest/clean.mjs cleanRulingBinding), and records the candidate's
//    evidence hash, which clean.mjs admit checks again.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CASE_NAME, benchRoot, buildCase, caseHash, casesRoot, gitEnv, parseCaseId, repoRoot } from "./lib/cases.mjs";
import { cleanRulingBinding } from "./ingest/clean.mjs";
import { drawAudit, redactor } from "./lib/drops.mjs";
import { CONTEXT_LINES, candidateItems, mergeQueue, openAsks, parseDiff } from "./lib/queue.mjs";
import { REAL, STATUSES, isPersonName, issueOf, readDecisions, resolveRulings, rulingProblems, specHashOf } from "./lib/rulings.mjs";
import { SCAN_CONFIG, scoreScanAttempts } from "./lib/scan-score.mjs";
import { plannedJobs } from "./lib/score.mjs";
import { SUITES, readSuite } from "./lib/suites.mjs";
import { loadRun } from "./score.mjs";

export const queueRoot = join(benchRoot, "review-queue");
const DECISIONS = "decisions.jsonl";

const readJsonl = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
function writeJsonl(path, items) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, items.map((i) => `${JSON.stringify(i)}\n`).join(""));
  renameSync(temp, path);
}

// The unresolved file to add: the path itself, or in a run folder its
// unresolved.jsonl, or its one unresolved-<specs>.jsonl.
function unresolvedFile(path) {
  if (statSync(path).isFile()) return path;
  const names = readdirSync(path).filter((n) => /^unresolved(-.+)?\.jsonl$/.test(n)).sort();
  if (names.includes("unresolved.jsonl")) return join(path, "unresolved.jsonl");
  if (names.length === 1) return join(path, names[0]);
  if (names.length === 0) throw new Error(`${path} holds no unresolved.jsonl; score the run first: node benchmark/score.mjs ${path}`);
  throw new Error(`${path} holds ${names.join(", ")}; name the one to add`);
}

export function add(path, { queue = queueRoot, candidates = false, specs = null } = {}) {
  if (candidates) return addCandidates(path, { queue, specs });
  if (specs !== null) throw new Error("refused: --specs is for add --candidates; score the run against other specs with score.mjs --specs first");
  const file = unresolvedFile(resolve(path));
  const items = readJsonl(file);
  const heldOut = items.filter((i) => i.split === "test");
  if (heldOut.length > 0) throw new Error(`refused: ${file} holds ${heldOut.length} findings of a held-out (test split) run, whose per-case detail stays in the run's asset`);
  return mergeInto(queue, items, file);
}

// The change of a case built from the live tree, with CONTEXT_LINES of
// context, as parseDiff rows by file; untracked files count as added.
// Where a case is built inside the temp folder `into`: a folder of its
// name. Refused when the name is not a planted case name or the path, with
// `into` resolved through any link, would leave it (failure 12).
function buildPathOf(name, into) {
  const root = realpathSync(into);
  const target = resolve(root, name, "repo");
  if (!CASE_NAME.test(name) || !target.startsWith(`${root}${sep}`)) throw new Error(`refused: the case ${JSON.stringify(name)} would be built at ${target}, outside ${root}`);
  return target;
}

// The case `name` built at `target` (buildPathOf), its change as parseDiff rows.
function caseDiff(name, target) {
  const { dir } = buildCase(name, target);
  const index = mkdtempSync(join(tmpdir(), "oq-bench-queue-index-"));
  try {
    const env = { ...gitEnv(), GIT_INDEX_FILE: join(index, "index") };
    const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
    git("read-tree", "HEAD");
    git("add", "-A", "-N");
    return parseDiff(git("diff", `-U${CONTEXT_LINES}`, "--no-color", "--no-renames", "HEAD").split("\n"));
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

// add --candidates: the run's scanner candidates no review raised and
// nothing frozen decides, merged into the queue.
function addCandidates(path, { queue, specs }) {
  const folder = resolve(path);
  if (!existsSync(join(folder, "manifest.json"))) throw new Error(`refused: ${folder} holds no manifest.json; add --candidates takes a run folder`);
  // A planted case's name becomes a path below: every name the manifest
  // holds is checked before any path is built from one (failure 12).
  const manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8"));
  if ((manifest.suite ?? "planted") === "planted") {
    const named = [...(Array.isArray(manifest.cases) ? manifest.cases : []), ...[...(Array.isArray(manifest.caseIds) ? manifest.caseIds : []), ...(Array.isArray(manifest.jobs) ? manifest.jobs.map((j) => j?.caseId) : [])].map((id) => parseCaseId(id)?.name ?? id)];
    const bad = named.find((n) => typeof n !== "string" || !CASE_NAME.test(n));
    if (bad !== undefined) throw new Error(`refused: ${folder} names the case ${JSON.stringify(bad)}, which is not a planted case name (lower case letters, digits and dashes), so nothing is read or built from the run`);
  }
  // A held-out run, suite or case never enters the committed queue (failure 7).
  const held = heldOutOf(manifest, plannedJobs(manifest, []).jobs);
  if (held !== null) throw new Error(`refused: ${folder} ${held}, whose per-case detail stays in the run's asset`);
  const run = loadRun(folder, { specsDir: specs === null ? null : existsSync(specs) ? resolve(specs) : join(folder, specs) });
  const m = run.manifest;
  const scored = scoreScanAttempts({ manifest: m, attempts: run.attempts, specs: run.specs });
  // The code at each candidate's lines: from the case built from the live
  // tree, where the run scanned that very case (its hash is the live one).
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-queue-cases-"));
  const diffs = new Map();
  try {
    const names = [...new Set(scored.jobs.filter((j) => j.candidates.some((c) => c.evidenceKind !== "frozen")).map((j) => j.case))];
    for (const name of (m.suite ?? "planted") === "planted" ? names : []) {
      const target = buildPathOf(name, temp);
      try {
        if (!existsSync(join(casesRoot, name, "case.json"))) continue;
        const live = caseHash(name);
        const recorded = m.caseHashes?.[name] ?? null;
        const hash8 = (m.caseIds ?? []).map(parseCaseId).find((p) => p?.name === name)?.hash8 ?? null;
        if (recorded === live || (recorded === null && hash8 === live.slice(0, 8))) diffs.set(name, caseDiff(name, target));
      } catch {
        // A case that cannot be built shows no code; the sheet says to open it.
      }
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const items = candidateItems({ runId: m.runId ?? basename(folder), build: m.build?.short ?? null, commit: m.build?.commit ?? null, suite: scored.suite, split: m.split ?? "dev", specsFrom: run.specsFrom ?? null, mode: m.mode ?? "review", jobs: scored.jobs, attempts: run.attempts, specs: run.specs, diffs });
  return mergeInto(queue, items, folder, "scanner candidates");
}

// Merges items into <queue>/<suite>.jsonl, keeping only the open questions.
function mergeInto(queue, items, file, what = "findings") {
  const d = readDecisions(join(queue, DECISIONS));
  const R = resolveRulings(d.lines, d.people);
  mkdirSync(queue, { recursive: true });
  const out = [];
  for (const suite of [...new Set(items.map((i) => i.suite))].sort()) {
    if (!/^[a-z][a-z0-9-]*$/.test(String(suite))) throw new Error(`refused: an item names the suite ${JSON.stringify(suite)}`);
    const target = join(queue, `${suite}.jsonl`);
    const before = readJsonl(target);
    const merged = mergeQueue(before, items.filter((i) => i.suite === suite), R, d);
    writeJsonl(target, merged);
    const had = new Set(before.map((i) => i.findingId));
    out.push(`${suite}: ${items.filter((i) => i.suite === suite).length} ${what} from ${file}; ${merged.filter((i) => !had.has(i.findingId)).length} new, ${merged.length} awaiting a ruling in ${target}`);
  }
  return out;
}

// The questions as the sheet asks them.
export const QUESTIONS = {
  match: "Is this finding the same issue as the truth item it sits on? Rule same-issue or different-issue.",
  real: "Is it a real issue in this change, one the case does not list? Rule true or false.",
};

// The blind sheet of the open items (lib/queue.mjs openAsks): { sheet,
// suite, seed, items }, each item with the case, the finding, the code and
// the truth item only.
export function blindSheet(items, { suite, seed }) {
  const known = [];
  for (const i of items) {
    for (const o of i.occurrences ?? []) {
      known.push({ kind: "run", value: o.run });
      // A scanner-only run's one configuration names no arm (failure 11).
      if (o.config !== SCAN_CONFIG) known.push({ kind: "configuration", value: o.config });
      // The full commit and its short form: either alone names the build.
      for (const value of [o.commit, o.build]) if (value) known.push({ kind: "build", value });
    }
  }
  const redact = redactor(known);
  const r = (s) => (s === null || s === undefined ? s : redact(s));
  return {
    sheet: `${suite}@${seed}`,
    suite,
    seed,
    items: drawAudit(items, items.length, seed).map((i, n) => ({
      item: n + 1,
      ref: i.findingId.slice(0, 12),
      issueId: i.issueId ?? null,
      caseId: i.caseId,
      file: r(i.file),
      lines: i.lines,
      category: i.category,
      severity: i.severity,
      // A scanner candidate shows its rule and message; a finding its four parts.
      ...(i.kind === "candidate" ? { kind: "candidate", rule: { token: r(i.rule.token), reference: r(i.rule.reference) }, message: r(i.message) } : { text: { title: r(i.text.title), problem: r(i.text.problem), consequence: r(i.text.consequence), fix: r(i.text.fix) } }),
      evidence: { lines: i.evidence.lines, text: r(i.evidence.text), context: r(i.evidence.context), sha256: i.evidence.sha256, missing: i.evidence.missing ?? [] },
      truth: i.truth ? { id: r(i.truth.id), file: r(i.truth.file), lines: i.truth.lines, text: r(i.truth.text) } : null,
      // Whether it is the truth item first: a same-issue ruling answers both.
      asks: ["match", "real"].filter((a) => i.asks.includes(a)).map((a) => QUESTIONS[a]),
    })),
  };
}

const span = (lines) => (lines[1] > lines[0] ? `lines ${lines[0]} to ${lines[1]}` : `line ${lines[0]}`);
function fenced(text, lang = "") {
  const longest = Math.max(0, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}${lang}`, text, fence];
}

// The sheet as a person reads it.
export function sheetMarkdown(s) {
  const out = [
    `# Review queue: ${s.suite}`,
    "",
    `Sheet ${s.sheet}: ${s.items.length} findings in a shuffled order (seed ${s.seed}). For each, read the case, the finding, the code and, when there is one, the truth item it sits on. Then record your ruling under your own name:`,
    "",
    "```",
    `node benchmark/queue.mjs decide same-issue|different-issue <ref> --by <your name> --sheet ${s.sheet}`,
    `node benchmark/queue.mjs decide true|false <ref> --by <your name> --sheet ${s.sheet}`,
    `node benchmark/queue.mjs decide consolidate <ref> <ref>... --by <your name> --sheet ${s.sheet}`,
    "```",
    "",
    "Consolidate findings of one case only when they are the same issue in other words. Sharing a line is not enough.",
    "",
    "A scanner candidate is a scanner's report on the change that no review raised. Rule it the same way, by its ref: true when it is a real issue in this change, false when it is not.",
    "",
  ];
  for (const x of s.items) {
    const head = x.kind === "candidate" ? [`- Scanner candidate: ${x.rule.token}, rated ${x.severity}`, `- Message: ${x.message}`, ...(x.rule.reference ? [`- Rule: ${x.rule.reference}`] : [])] : [`- Kind: ${x.category}, rated ${x.severity}`, `- Title: ${x.text.title}`, `- Problem: ${x.text.problem}`, `- Consequence: ${x.text.consequence}`, `- Fix: ${x.text.fix}`];
    out.push(`## ${x.item}. ${x.ref}`, "", `- Case: ${x.caseId}`, `- Place: ${x.file}, ${span(x.lines)}`, ...head, "");
    if (x.evidence.text !== null) {
      out.push("The code at those lines:", "", ...fenced(x.evidence.text), "");
      if (x.evidence.missing.length > 0) out.push(`The diff did not show line ${x.evidence.missing.join(", ")}.`, "");
      out.push("The change around them:", "", ...fenced(x.evidence.context, "diff"), "");
    } else if (x.evidence.sha256 !== null) out.push(`The code is not shown here: the case's licence does not allow it. Its sha256 is ${x.evidence.sha256}; open the case to read it.`, "");
    else out.push(x.kind === "candidate" ? "The code is not shown here; open the case to read it." : "The diff the reviewer was given does not show those lines; open the case to read them.", "");
    if (x.truth) out.push(`The truth item it sits on: ${x.truth.id}, ${x.truth.file} ${span(x.truth.lines)}. ${x.truth.text}`, "");
    if (x.issueId) out.push(`A person consolidated it into ${x.issueId}: rule the whole issue with decide true|false ${x.issueId}.`, "");
    for (const q of x.asks) out.push(`- ${q}`);
    out.push("- Ruling: ", "");
  }
  return out.join("\n");
}

export function sheet(suite, { seed, queue = queueRoot } = {}) {
  const d = readDecisions(join(queue, DECISIONS));
  const R = resolveRulings(d.lines, d.people);
  const open = [];
  for (const item of readJsonl(join(queue, `${suite}.jsonl`))) {
    const asks = openAsks(item, R, d);
    if (asks.length > 0) open.push({ ...item, issueId: issueOf(item.findingId, R), asks, truth: asks.includes("match") ? item.truth : null });
  }
  return blindSheet(open, { suite, seed });
}

// Every finding decide can name: the queue's items, and the findings the
// adjudication file already names (a ruled finding leaves the queue but can
// still be consolidated).
function knownFindings(queue, lines) {
  const known = new Map();
  const files = existsSync(queue) ? readdirSync(queue).filter((n) => n.endsWith(".jsonl") && n !== DECISIONS) : [];
  for (const name of files.sort()) for (const i of readJsonl(join(queue, name))) known.set(i.findingId, { caseId: i.caseId, evidence: i.evidence, truth: i.truth, specsFrom: i.specsFrom ?? null, file: i.file, lines: i.lines, specHash: i.specHash ?? null, changedLines: i.changedLines ?? null, truthItems: i.truthItems ?? null, kind: i.kind ?? "finding" });
  const fromLines = new Set();
  for (const l of lines) {
    if (!l || typeof l !== "object" || !l.target) continue;
    const ids = [l.target.findingId, ...(Array.isArray(l.target.members) ? l.target.members : [])].filter((x) => typeof x === "string");
    for (const id of ids) {
      if (known.has(id)) continue;
      known.set(id, { caseId: l.caseId, evidence: l.target.findingId === id ? (l.evidence ?? null) : null, truth: null, specsFrom: l.specsFrom ?? null, file: null, lines: null, specHash: null, changedLines: null, truthItems: null, kind: "finding" });
      fromLines.add(id);
    }
    // A candidate known only from its rulings (it left the queue) keeps the
    // spec version of its latest one, so a person can change their mind.
    if (l.target.candidate === true && fromLines.has(l.target.findingId)) Object.assign(known.get(l.target.findingId), { kind: "candidate", specHash: l.target.specHash ?? null });
  }
  return known;
}

function findingOf(ref, known) {
  if (!/^[0-9a-f]{8,64}$/.test(ref)) throw new Error(`refused: ${ref} is not a finding ref (8 or more hex of a findingId)`);
  const hits = [...known.keys()].filter((id) => id.startsWith(ref));
  if (hits.length !== 1) throw new Error(`refused: ${ref} matches ${hits.length === 0 ? "no finding in the queue or the adjudication file" : `${hits.length} findings; give more of it`}`);
  return { findingId: hits[0], ...known.get(hits[0]) };
}

const evidenceOf = (f) => (f.evidence ? { text: f.evidence.text ?? null, lines: f.evidence.lines, sha256: f.evidence.sha256 ?? null } : null);

// A path as a ruling records it: relative to the repository when it lies in
// it, so no machine path is written.
const shownPath = (p) => {
  const r = relative(repoRoot, p);
  return r !== "" && !r.startsWith("..") && !isAbsolute(r) ? r : p;
};

// Why a run is held out, or null: a run of the test split, a run of a suite
// whose every case is held out, or a run of a case the committed split puts
// on its test side.
function heldOutOf(manifest, jobs) {
  if ((manifest.split ?? "dev") !== "dev") return `is a run of the ${manifest.split} split, which is held out`;
  const suite = manifest.suite ?? "planted";
  if (!SUITES[suite]) return null;
  if (SUITES[suite].heldOutOnly) return `is a run of the ${suite} suite, whose every case is held out`;
  const test = new Set(readSuite(suite).split?.cases?.test ?? []);
  const held = [...new Set(jobs.map((j) => j.case))].filter((name) => test.has(name)).sort();
  return held.length === 0 ? null : `ran ${held.join(", ")}, held out by the ${suite} split`;
}

// The case and spec version a bug ruling judges, from the run it names: the
// run's id for the case (its own, or the one a bare <suite>/<name> names),
// and the case's spec in the run's cases/ copy or in the folder `specs`
// names, which must list the truth item.
function specOfRun(run, caseId, bug, specs) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
  } catch {
    throw new Error(`refused: ${run} holds no manifest.json that can be read, so it names no run`);
  }
  const jobs = plannedJobs(manifest, []).jobs;
  const held = heldOutOf(manifest, jobs);
  if (held !== null) throw new Error(`refused: ${run} ${held}, so its spec is never ruled on`);
  const bare = (id) => {
    const p = parseCaseId(id);
    return p ? `${p.suite}/${p.name}` : id;
  };
  const named = [...new Map(jobs.filter((j) => j.caseId === caseId || bare(j.caseId) === caseId).map((j) => [j.caseId, j])).values()];
  if (named.length !== 1) throw new Error(`refused: the run ${run} scored ${named.length === 0 ? "no case" : "more than one case named"} ${caseId}; its cases are ${[...new Set(jobs.map((j) => j.caseId))].sort().join(", ") || "none"}`);
  const folder = specs ?? join(run, "cases");
  const file = join(folder, `${named[0].case}.json`);
  let spec;
  try {
    spec = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`refused: ${file} cannot be read as the spec of ${named[0].caseId}`);
  }
  if (!(spec?.bugs ?? []).some((b) => b?.id === bug)) throw new Error(`refused: the spec ${file} lists no truth item ${bug}; it lists ${(spec?.bugs ?? []).map((b) => b?.id).join(", ") || "none"}`);
  return { caseId: named[0].caseId, specHash: specHashOf(spec), specsFrom: specs ? shownPath(specs) : null };
}

// The truth item a match ruling judges the finding `f` against: the one
// the queue item names, or for same-issue the one --bug names, which must
// be a truth item of the same spec version, in the finding's own file, with
// the finding on a line the change added there.
function matchTarget(status, f, bug) {
  if (!f.specHash) throw new Error(`refused: the queue item of ${f.findingId.slice(0, 12)} names no spec version (it was queued before the version was recorded); add its run to the queue again with queue.mjs add <run>, then rule`);
  if (bug === null || bug === f.truth?.id) {
    if (!f.truth) throw new Error(`refused: the queue names no truth item this finding sits on, so there is nothing to rule ${status} against${status === "same-issue" ? "; to join it to a truth item of its own file, name the item with --bug <id>" : ""}`);
    return f.truth.id;
  }
  if (status !== "same-issue") throw new Error(`refused: ${status} answers the truth item the finding sits on${f.truth ? ` (${f.truth.id})` : ""}; --bug names another truth item only for same-issue`);
  const item = (f.truthItems ?? []).find((t) => t.id === bug);
  if (!item) throw new Error(`refused: the spec this finding was scored against lists no truth item ${bug}; it lists ${(f.truthItems ?? []).map((t) => t.id).join(", ") || "none"}`);
  if (!item.files.includes(f.file)) throw new Error(`refused: ${bug} sits in ${item.files.join(", ")}, not in ${f.file}, where the finding is; a same-issue ruling joins a finding only to a truth item of its own file`);
  if ((f.changedLines ?? []).length === 0) throw new Error(`refused: the finding's lines in ${f.file} (${f.lines.join(" to ")}) hold no line the change added, so it is no find of ${bug} in this change`);
  return bug;
}

// The ruling line for one decide call, checked; throws when it is refused.
export function rulingLine(status, targets, { by, bug = null, run = null, specs = null, note = "", sheet: fromSheet = null, queue = queueRoot, now = new Date() } = {}) {
  const { lines, people } = readDecisions(join(queue, DECISIONS));
  if (!isPersonName(by, people)) throw new Error(`refused: --by must name the person who made this ruling, as ${join(queue, "people.json")} lists them, not ${JSON.stringify(by ?? null)}. A model or an agent never rules; the session may draft rulings, and a person records them.`);
  const kinds = Object.entries(STATUSES).filter(([, s]) => s.includes(status)).map(([k]) => k);
  if (kinds.length === 0) throw new Error(`refused: ${status} is not a status; use one of ${[...new Set(Object.values(STATUSES).flat())].join(", ")}`);
  // A flag a status does not read is refused, never ignored: a ruling must say what the person meant.
  const onBug = kinds.includes("bug");
  if (bug !== null && !onBug && !kinds.includes("match")) throw new Error(`refused: ${status} takes no --bug; --bug names a truth item for confirmed, disputed and same-issue`);
  if ((run !== null || specs !== null) && !onBug) throw new Error(`refused: ${status} takes no --run or --specs; they name the spec version for confirmed and disputed`);
  if (specs !== null && run === null) throw new Error("refused: --specs names the spec folder of the run --run names; name the run too");
  const R = resolveRulings(lines, people);
  const known = knownFindings(queue, lines);
  const one = () => {
    if (targets.length !== 1) throw new Error(`refused: ${status} takes one target, not ${targets.length}`);
    return targets[0];
  };
  let caseId;
  let target;
  let found = null;
  let specsFrom = null;
  let bound = null;
  if (status === "confirmed" || status === "disputed") {
    if (!bug) throw new Error(`refused: ${status} names the truth item with --bug <id>`);
    if (run === null) throw new Error(`refused: ${status} names the run whose spec it judges with --run <run folder> (and --specs <folder> when that run was scored against other specs), so it never reaches another version of the case`);
    const v = specOfRun(resolve(run), one(), bug, specs === null ? null : resolve(specs));
    caseId = v.caseId;
    specsFrom = v.specsFrom;
    target = { kind: "bug", id: bug, specHash: v.specHash };
  } else if (status === "clean" || status === "not-clean") {
    caseId = one();
    target = { kind: "case" };
    // A clean candidate's ruling binds to the sheet's version of the
    // candidates and to the candidate's evidence (failure 13).
    if (caseId.startsWith("clean/")) {
      const b = cleanRulingBinding(caseId, fromSheet, { root: dirname(queue) });
      if (b.problem) throw new Error(`refused: ${b.problem}`);
      bound = b.evidence;
    }
  } else if (status === "consolidate") {
    const members = targets.map((t) => findingOf(t, known));
    // A candidate is ruled one by one, on its spec version; an issue ruling would not count for it.
    const candidate = members.find((m) => m.kind === "candidate");
    if (candidate) throw new Error(`refused: ${candidate.findingId.slice(0, 12)} is a scanner candidate, which is ruled on its own with true, false, same-issue or different-issue, never consolidated`);
    const ids = [...new Set(members.map((m) => m.findingId))].sort();
    if (ids.length < 2) throw new Error("refused: consolidate names two or more different findings");
    const cases = [...new Set(members.map((m) => m.caseId))];
    if (cases.length !== 1) throw new Error(`refused: the findings belong to ${cases.length} cases (${cases.join(", ")}); an issue is of one case`);
    caseId = cases[0];
    const prefix = `${caseId}#I`;
    const used = lines.filter((l) => typeof l?.target?.issueId === "string" && l.target.issueId.startsWith(prefix)).map((l) => Number(l.target.issueId.slice(prefix.length))).filter(Number.isInteger);
    target = { kind: "issue", issueId: `${prefix}${Math.max(0, ...used) + 1}`, members: ids };
  } else if (REAL[status] && /#I\d+$/.test(one())) {
    const issueId = one();
    if (!R.grouped.has(issueId)) throw new Error(`refused: no person consolidated ${issueId}; consolidate its findings first`);
    caseId = issueId.slice(0, issueId.lastIndexOf("#I"));
    target = { kind: "issue", issueId, members: [...R.members].filter(([, i]) => i === issueId).map(([f]) => f).sort() };
  } else if (REAL[status]) {
    found = findingOf(one(), known);
    caseId = found.caseId;
    target = { kind: "finding", findingId: found.findingId };
  } else {
    found = findingOf(one(), known);
    caseId = found.caseId;
    target = { kind: "match", findingId: found.findingId, truthId: matchTarget(status, found, bug), specHash: found.specHash };
  }
  // A scanner candidate's ruling says it is one, and names the version of
  // the spec it was scored against; only that version reads it (lib/
  // rulings.mjs candidateRuling).
  if (found?.kind === "candidate") {
    if (!found.specHash) throw new Error(`refused: the queue item of ${found.findingId.slice(0, 12)} names no spec version; add its run again with queue.mjs add --candidates <run>, then rule`);
    target = { ...target, candidate: true, specHash: found.specHash };
  }
  specsFrom ??= found?.specsFrom ?? null;
  const line = { v: 1, caseId, ...(specsFrom ? { specsFrom } : {}), fromSheet, target, status, by: by.trim(), at: now.toISOString(), note, evidence: found ? evidenceOf(found) : bound };
  const problems = rulingProblems(line, people);
  if (problems.length > 0) throw new Error(`refused: ${problems.join("; ")}`);
  return line;
}

export function decide(status, targets, opts = {}) {
  const queue = opts.queue ?? queueRoot;
  const line = rulingLine(status, targets, { ...opts, queue });
  mkdirSync(queue, { recursive: true });
  appendFileSync(join(queue, DECISIONS), `${JSON.stringify(line)}\n`);
  const what = line.target.kind === "finding" || line.target.kind === "match" ? `finding ${line.target.findingId.slice(0, 12)}` : line.target.kind === "issue" ? line.target.issueId : line.target.kind === "bug" ? `${line.caseId} truth item ${line.target.id}` : line.caseId;
  const version = line.target.specHash ? ` (spec version ${line.target.specHash.slice(0, 12)})` : "";
  return `Recorded ${status} on ${what}${line.target.kind === "match" ? ` against ${line.target.truthId}` : ""}${version}, by ${line.by}, in ${join(queue, DECISIONS)}`;
}

const USAGE = `usage:
  node benchmark/queue.mjs add <run folder | unresolved file> [--queue <folder>]
  node benchmark/queue.mjs add --candidates <run folder> [--specs <folder>] [--queue <folder>]
  node benchmark/queue.mjs sheet <suite> [--seed <n>] [--json] [--queue <folder>]
  node benchmark/queue.mjs decide <status> <target>... --by <your name> [--bug <id>] [--run <run folder> [--specs <folder>]] [--note <text>] [--sheet <id>] [--queue <folder>]`;

function main() {
  const args = process.argv.slice(2);
  const opts = { json: false, candidates: false };
  const pos = [];
  const valued = { "--queue": "queue", "--seed": "seed", "--by": "by", "--bug": "bug", "--run": "run", "--specs": "specs", "--note": "note", "--sheet": "sheet" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") opts.json = true;
    else if (args[i] === "--candidates") opts.candidates = true;
    else if (valued[args[i]]) {
      if (i + 1 >= args.length) {
        console.error(`${args[i]} needs a value\n${USAGE}`);
        process.exit(2);
      }
      opts[valued[args[i]]] = args[++i];
    } else if (args[i].startsWith("--")) {
      console.error(`unknown flag ${args[i]}\n${USAGE}`);
      process.exit(2);
    } else pos.push(args[i]);
  }
  const queue = opts.queue ? resolve(opts.queue) : queueRoot;
  const [command, ...rest] = pos;
  try {
    if (command === "add" && rest.length === 1) for (const l of add(rest[0], { queue, candidates: opts.candidates, specs: opts.specs ?? null })) console.log(l);
    else if (command === "sheet" && rest.length === 1) {
      const seed = opts.seed === undefined ? Math.floor(Date.now() / 1000) % 2147483647 : Number(opts.seed);
      if (!Number.isInteger(seed) || seed < 0) throw new Error(`refused: --seed must be a whole number, not ${opts.seed}`);
      const s = sheet(rest[0], { seed, queue });
      console.log(opts.json ? JSON.stringify(s, null, 2) : sheetMarkdown(s));
    } else if (command === "decide" && rest.length >= 2) console.log(decide(rest[0], rest.slice(1), { by: opts.by, bug: opts.bug ?? null, run: opts.run ?? null, specs: opts.specs ?? null, note: opts.note ?? "", sheet: opts.sheet ?? null, queue }));
    else {
      console.error(USAGE);
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}

// Run as a script, not imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
