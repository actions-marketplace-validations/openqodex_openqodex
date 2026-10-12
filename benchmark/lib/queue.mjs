// The review queue, benchmark/review-queue/<suite>.jsonl: one line per
// finding that still puts a question to a person (is it a real issue; is
// it the truth item it sits on), with what the person rules from. score.mjs
// writes a run's items to unresolved.jsonl; queue.mjs add merges them into
// the queue, sheet prints them blind, and decide records a ruling in the
// adjudication file (lib/rulings.mjs).
//
// An item:
//   { v: 1, findingId, issueId (a person's consolidation, or null), caseId,
//     suite, split, specsFrom, file, lines,
//     category, severity, text: { title, problem, consequence, fix },
//     evidence: { lines, text, context, sha256, from, missing },
//     truth: { id, file, lines, text } | null, asks: ["real", "match"],
//     occurrences: [{ run, build, commit, config, repeat, outcome }],
//     specHash, changedLines: [line], truthItems: [{ id, files }] }
// specHash is the version of the spec the item was scored against (lib/
// rulings.mjs specHashOf), which every match ruling on it names;
// changedLines are its lines the change added, from the brief's diff; and
// truthItems are that spec's truth items with the files each sits in. They
// are what decide checks a same-issue ruling that names a truth item
// against (rules version 8). An item queued before them has none, and
// decide asks for its run to be added again.
// A scanner candidate no review raised has an item of its own kind
// (candidateItems below), which queue.mjs add --candidates merges in.
//
// Failure list, written before the code:
// 1. An item lacks what a person needs to rule: it keeps the finding's own
//    words, the lines it cites, the code at those lines and the change
//    around them as the brief gave them to the reviewer (only the code's
//    hash when the case's licence is not permissive), and, when it sits on
//    a truth item, that item's id, place and text.
// 2. One finding seen in many reviews becomes many items, or its count
//    reaches the person: one item per findingId; every occurrence is kept
//    for the record and none reaches the sheet.
// 3. A planted case's generated secret lands in the committed queue: every
//    generated value is put back as its placeholder in every text kept.
// 4. A held-out run's per-case findings enter the committed queue: add
//    refuses items from a test split.
// 5. An answered question stays in the queue, or an open one leaves it:
//    each add reads the rulings again and keeps exactly the open questions.
// 6. A deleted line that begins with "--" or "++" is read as a file header:
//    a hunk's rows are counted from its header, so only rows outside a hunk
//    are headers.
// 7. A match ruling on one spec version answers the item's question on
//    another: an item asks again when the rulings on its finding name
//    another spec version than its own.
// The blind sheet is queue.mjs's (failure 6 there).
import { createHash } from "node:crypto";
import { generatedValue } from "./cases.mjs";
import { candidateRuling, issueOf, matchRuling, realRuling, specHashOf } from "./rulings.mjs";
import { asksOf, normPath, shownFindings } from "./score.mjs";

export const QUEUE_VERSION = 1;
// Lines of the change shown on either side of the cited lines.
export const CONTEXT_LINES = 12;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// The diff a brief gave the reviewer, file by file (new-side paths): each
// row with its kind (" ", "+", "-", or "@" for a hunk header) and the new
// line it sits at (a deleted row sits before the new line that follows).
export function briefDiff(brief) {
  if (typeof brief !== "string") return new Map();
  const lines = brief.split("\n");
  const heading = lines.indexOf("## Diff");
  const start = heading === -1 ? -1 : lines.findIndex((l, i) => i > heading && /^`{3,}diff$/.test(l));
  if (start === -1) return new Map();
  return parseDiff(lines.slice(start + 1), lines[start].slice(0, -"diff".length));
}

// A unified diff's lines, file by file, as briefDiff gives them; it stops
// at the line `fence` when one is given (the end of a brief's diff block).
export function parseDiff(lines, fence = null) {
  const out = new Map();
  let rows = null;
  let next = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("\\")) continue;
      const kind = line.startsWith("+") || line.startsWith("-") ? line[0] : " ";
      rows?.push({ kind, text: line.slice(1), at: next });
      if (kind !== "+") oldLeft--;
      if (kind !== "-") {
        newLeft--;
        next++;
      }
      continue;
    }
    if (line === fence) break;
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && rows !== null) {
      oldLeft = h[1] === undefined ? 1 : Number(h[1]);
      next = Number(h[2]);
      newLeft = h[3] === undefined ? 1 : Number(h[3]);
      rows.push({ kind: "@", text: line, at: next });
    } else if (line.startsWith("diff --git ")) rows = null;
    else if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") rows = null;
      else {
        const file = normPath(path.replace(/^b\//, ""));
        if (!out.has(file)) out.set(file, []);
        rows = out.get(file);
      }
    }
  }
  return out;
}

// What a case's code may show in the committed queue: a planted case is this
// repository's own code; a real case only under a permissive licence.
export const licenceOf = (spec, suite) => (suite === "planted" ? "permissive" : (spec?.source?.licence?.class ?? "unknown"));

// Each generated value of a planted case, with the placeholder it replaced.
function generatedOf(spec) {
  const out = [];
  for (const g of spec?.generated ?? []) {
    try {
      out.push([generatedValue(spec.id, g.file, g.kind), g.placeholder]);
    } catch {
      // A kind this code cannot make has no value to look for.
    }
  }
  return out;
}

const unGenerate = (pairs) => (s) => (typeof s === "string" ? pairs.reduce((t, [value, placeholder]) => t.split(value).join(placeholder), s) : s);

// The code at lines [start, end] of `file`, from the diff the brief gave the
// reviewer, and the change around it. `text` holds the new-side lines the
// diff shows (`missing` lists the rest); `context` the diff rows within
// CONTEXT_LINES of the range, deleted rows included; `sha256` the text's
// hash. Without permission to publish the code, text and context are null
// and only the hash stays. `from` names where the diff came from: the
// reviewer's brief, or the case built from the live tree.
export function evidenceOf({ diff, file, start, end, permissive = true, clean = (s) => s, from = "brief" }) {
  const rows = diff.get(file) ?? [];
  const shown = new Map(rows.filter((r) => r.kind === " " || r.kind === "+").map((r) => [r.at, r.text]));
  const missing = [];
  const text = [];
  for (let n = start; n <= end; n++) {
    if (shown.has(n)) text.push(shown.get(n));
    else missing.push(n);
  }
  if (text.length === 0) return { lines: [start, end], text: null, context: null, sha256: null, from: null, missing };
  const body = clean(text.join("\n"));
  const context = clean(rows.filter((r) => r.at >= start - CONTEXT_LINES && r.at <= end + CONTEXT_LINES).map((r) => (r.kind === "@" ? r.text : `${r.kind}${r.text}`)).join("\n"));
  return { lines: [start, end], text: permissive ? body : null, context: permissive ? context : null, sha256: sha256(body), from, missing };
}

// The queue items of one scored run: every finding of a first attempt that
// still asks a question (lib/score.mjs asksOf), one item per findingId, with
// each occurrence. `jobs` and `suite` come from scoreAttempts, `attempts`
// and `specs` from the loaded run.
export function unresolvedItems({ runId, build = null, commit = null, suite, split = "dev", specsFrom = null, jobs, attempts, specs }) {
  const items = new Map();
  for (const j of jobs) {
    const first = attempts.find((a) => a.case === j.case && a.config === j.config && a.repeat === j.repeat && a.attempt === 1);
    if (!first) continue;
    const spec = specs[j.case];
    const specHash = specHashOf(spec);
    const truthItems = (spec.bugs ?? []).filter((b) => b.valid !== false).map((b) => ({ id: b.id, files: [...new Set([b.file, ...(b.also ?? []).map((a) => a.file)].map(normPath))] }));
    const clean = unGenerate(generatedOf(spec));
    const shown = shownFindings(first.report);
    let diff = null;
    for (const f of j.findings) {
      const asks = asksOf(f);
      if (asks.length === 0) continue;
      let item = items.get(f.findingId);
      if (!item) {
        const raw = shown[f.index];
        const start = raw.line_number;
        const end = Math.max(raw.line_end ?? start, start);
        diff ??= briefDiff(first.brief);
        const bug = asks.includes("match") ? (spec.bugs ?? []).find((b) => b.id === f.bug) : null;
        item = {
          v: QUEUE_VERSION,
          findingId: f.findingId,
          issueId: f.issueId ?? null,
          caseId: j.caseId,
          suite,
          split,
          specsFrom,
          file: normPath(raw.file_path),
          lines: [start, end],
          category: raw.category ?? null,
          severity: raw.severity ?? null,
          text: { title: clean(raw.title ?? ""), problem: clean(raw.problem ?? ""), consequence: clean(raw.consequence ?? ""), fix: clean(raw.fix ?? "") },
          evidence: evidenceOf({ diff, file: normPath(raw.file_path), start, end, permissive: licenceOf(spec, suite) === "permissive", clean }),
          truth: bug ? { id: bug.id, file: normPath(bug.file), lines: bug.lines, text: clean(bug.truth ?? bug.description ?? "") } : null,
          asks,
          occurrences: [],
          specHash,
          changedLines: (diff.get(normPath(raw.file_path)) ?? []).filter((r) => r.kind === "+" && r.at >= start && r.at <= end).map((r) => r.at),
          truthItems,
        };
        items.set(f.findingId, item);
      }
      item.occurrences.push({ run: runId, build, commit, config: j.config, repeat: j.repeat, outcome: f.outcome });
    }
  }
  return [...items.values()];
}

// The queue items of a run's scanner candidates that no review raised and
// nothing frozen decides (the scan scorer's unresolved and near
// candidates): every such candidate of a scanner-only run, and of a review
// run each the review dropped. A reviewer's drop is not shown: the person
// rules from the case, the candidate and the code. One item per candidate
// identity (lib/scan-score.mjs candidateIdOf: the case, the scanner and
// rule, the file, the lines and the message), with each occurrence. `jobs`
// are scoreScanAttempts' jobs, `attempts` and `specs` the loaded run's,
// `diffs` each case's change (parseDiff rows by file, by case name) where
// the case could be built.
//
// A candidate item:
//   { v: 1, kind: "candidate", findingId (the candidate's identity), issueId,
//     caseId, suite, split, specsFrom, file, lines, category: null, severity
//     (the developer's scale), rule: { scanner, id, token, reference },
//     message, evidence, truth, asks,
//     occurrences: [{ run, build, commit, config, repeat, outcome, disposition }],
//     specHash }
// Its rulings are a finding's or a match's (true, false, same-issue,
// different-issue), keyed on its identity and on specHash, the version of
// the spec it was scored against (lib/rulings.mjs specHashOf), which every
// ruling on it names: a revised spec may list an issue on its lines, so a
// ruling on one version never answers another (lib/rulings.mjs
// candidateRuling). The same item scored against a revised spec asks again.
//
// Failure list, written before the code:
// 8. A scanner candidate no review raised cannot enter the queue, so nobody
//    can rule on what a scanner change removes: this builds its item.
// 9. The reviewer's verdict reaches the person who rules: a dropped
//    candidate's item holds no drop reason.
// 10. A candidate frozen evidence decides (a hit, a listed side issue, a
//    candidate on a clean control) asks a person anyway: it is left out.
export function candidateItems({ runId, build = null, commit = null, suite, split = "dev", specsFrom = null, mode = "scan", jobs, attempts, specs, diffs = new Map() }) {
  const items = new Map();
  const reviewed = mode !== "scan";
  for (const j of jobs) {
    const first = attempts.find((a) => a.case === j.case && a.config === j.config && a.repeat === j.repeat && a.attempt === 1);
    const raw = first?.scan?.candidates ?? [];
    // A review that saved no report says nothing of what it raised or dropped.
    if (raw.length === 0 || (reviewed && !first.report)) continue;
    const shown = new Set([...(first.report?.findings ?? []), ...(first.report?.outside_change ?? [])].map((f) => f.candidate).filter((x) => typeof x === "string"));
    const held = new Set((first.submission?.findings ?? []).map((f) => f?.candidate).filter((x) => typeof x === "string"));
    const dropped = new Set((first.report?.dropped ?? []).map((d) => d?.candidate?.id).filter((x) => typeof x === "string" && !shown.has(x) && !held.has(x)));
    const spec = specs[j.case];
    const clean = unGenerate(generatedOf(spec));
    for (const c of j.candidates) {
      if (c.evidenceKind === "frozen") continue;
      const r = raw[c.index];
      if (reviewed && !dropped.has(r.id)) continue;
      let item = items.get(c.candidateId);
      if (!item) {
        const bug = c.bug ? (spec.bugs ?? []).find((b) => b.id === c.bug) : null;
        item = {
          v: QUEUE_VERSION,
          kind: "candidate",
          findingId: c.candidateId,
          issueId: null,
          caseId: j.caseId,
          suite,
          split,
          specsFrom,
          file: c.file,
          lines: [c.line, c.end],
          category: null,
          severity: r.reviewSeverity ?? null,
          rule: { scanner: r.source, id: r.ruleId, token: c.token, reference: r.reference ?? null },
          message: clean(r.message ?? ""),
          evidence: evidenceOf({ diff: diffs.get(j.case) ?? new Map(), file: c.file, start: c.line, end: c.end, permissive: licenceOf(spec, suite) === "permissive", clean, from: "case" }),
          truth: bug ? { id: bug.id, file: normPath(bug.file), lines: bug.lines, text: clean(bug.truth ?? bug.description ?? "") } : null,
          asks: bug ? ["real", "match"] : ["real"],
          occurrences: [],
          specHash: specHashOf(spec),
        };
        items.set(c.candidateId, item);
      }
      item.occurrences.push({ run: runId, build, commit, config: j.config, repeat: j.repeat, outcome: c.outcome, disposition: reviewed ? "dropped" : "unreviewed" });
    }
  }
  return [...items.values()];
}

// The questions of an item that the rulings in force (lib/rulings.mjs) have
// not answered. A same-issue ruling on its spec version answers both; a
// ruling on whether it is a real issue answers that; a match ruling on its
// spec version, or a false ruling, answers whether it is the truth item.
export function openAsks(item, R, D = { lines: [], people: [] }) {
  const id = item.findingId;
  // A scanner candidate's questions are answered only by rulings on the
  // spec version it was scored against (lib/rulings.mjs candidateRuling;
  // `D` the file's lines and people).
  if (item.kind === "candidate") {
    const r = candidateRuling(id, item.specHash, D);
    if (r.status === "same-issue") return [];
    return item.asks.filter((a) => (a === "real" ? r.status === null : r.status !== "false" && item.truth !== null && !r.answered.includes(item.truth.id)));
  }
  const same = [...(R.matches.get(id) ?? new Map()).values()].some((m) => m.status === "same-issue" && m.specHash === item.specHash);
  if (same) return [];
  const real = realRuling(id, R);
  return item.asks.filter((a) => (a === "real" ? real === null : real?.status !== "false" && item.truth !== null && matchRuling(id, item.truth.id, item.specHash, R) === null));
}

const occurrenceKey = (o) => `${o.run}\0${o.config}\0${o.repeat}`;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The queue after adding a run's items: one item per findingId with every
// occurrence once, the latest scoring's questions, truth item, spec version,
// added lines and truth items, only the
// questions the rulings leave open, the issue a person put it in (or
// null), sorted so the file diffs well.
export function mergeQueue(queue, incoming, R, D = { lines: [], people: [] }) {
  const all = new Map(queue.map((i) => [i.findingId, { ...i, occurrences: [...i.occurrences] }]));
  for (const item of incoming) {
    const old = all.get(item.findingId);
    if (!old) {
      all.set(item.findingId, { ...item, occurrences: [...item.occurrences] });
      continue;
    }
    const seen = new Set(old.occurrences.map(occurrenceKey));
    for (const o of item.occurrences) if (!seen.has(occurrenceKey(o))) old.occurrences.push(o);
    old.asks = item.asks;
    old.truth = item.truth;
    old.specHash = item.specHash;
    old.changedLines = item.changedLines;
    old.truthItems = item.truthItems;
  }
  const out = [];
  for (const item of all.values()) {
    const asks = openAsks(item, R, D);
    if (asks.length === 0) continue;
    item.occurrences.sort((a, b) => byText(occurrenceKey(a), occurrenceKey(b)));
    out.push({ ...item, issueId: issueOf(item.findingId, R), asks, truth: asks.includes("match") ? item.truth : null });
  }
  return out.sort((a, b) => byText(a.caseId, b.caseId) || byText(a.file, b.file) || a.lines[0] - b.lines[0] || byText(a.findingId, b.findingId));
}
