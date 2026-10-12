// Why a review missed a truth item, and why a finding it showed is not one,
// read from the review's saved files only: the score of its first attempt
// (lib/score.mjs, rulings applied), its report with the drops, its
// submission, its brief, its trace, its correction rounds (rounds.json) and
// its scan. Nothing here reads a file or calls a model; score.mjs and
// causes.mjs do the reading. The causes are the reviewer part's fixed list
// (the benchmark plan, part P3 4.2), and every cause is a fact the files
// show; where only a person can say, the cause is unresolved.
//
// A truth item a review did not find gets one cause, the first that holds:
//   incomplete          the review did not complete (incomplete, failed, or
//                       never started).
//   spec-disputed       a person ruled the truth item wrong (a bug ruling,
//                       lib/rulings.mjs) in the spec version the job is
//                       scored against.
//   not-in-brief        no line of the item, at any of its places, was in
//                       the brief's diff, a correction round or a read.
//   not-read            the item's proof outside the change (its evidence)
//                       was in none of them.
//   finalize-floor      the reviewer submitted a finding that finds it, and
//                       finalize set it aside under the confidence floor.
//   finalize-threshold  the same, counted below the severity threshold and
//                       not listed.
//   finalize-rejected   a correction round's answer held such a finding and
//                       the final answer left it out.
//   line-off            a shown finding finds it but for its lines (near).
//   wrong-kind          a shown finding finds it but for its kind.
//   unresolved          a shown finding nobody has ruled on may be it: one on
//                       its lines (a location match), or one that names it,
//                       of its kind, in its file at a place the spec does not
//                       list, by a word no other truth item of the case
//                       lists. A person's same-issue ruling makes it found; a
//                       different-issue ruling moves the miss on.
//   candidate-dropped   a scanner candidate that located it (by the scorer's
//                       finder rule: its expected scanner, or words that name
//                       it) was dropped by the reviewer; every such drop is
//                       kept with its reason and its class from drops.mjs.
//   judged-wrong        none of the above: its lines were in front of the
//                       reviewer, no dropped candidate located it, and the
//                       review raised nothing that finds it. Each part must be
//                       on record (the lines seen, its proof read when it has
//                       some, the final answer and every correction round
//                       saved); a part that is not makes the miss unresolved.
// A shown finding counted in precision that finds no truth item gets one
// cause from its outcome: line-off (near), wrong-kind, real-unlisted (a
// person ruled it a real issue the truth does not list), false (a person
// ruled it false, or the spec decides it, as on a clean case), unresolved
// (nobody has ruled yet; never a lever's evidence). The plan's false-pending
// is named unresolved, the score's own word for it.
//
// Two of the plan's causes are not assigned, because the scorer's rulings
// (rules version 5) decide them first: words-off (a finding on the item's
// lines whose words do not name it is a location match, so the miss is
// unresolved until a person rules) and spec-location (a person's same-issue
// ruling on a finding at an unlisted place makes it a hit, so the item is
// found and the finding is no non-hit).
//
// Failure list, written before the code:
// 1. A found truth item gets a cause, or a missed one gets none or two: a
//    cause is given only to an item the score counts as not found, and the
//    first rule that holds decides.
// 2. A miss with no scanner candidate on it is labelled a drop: only a
//    dropped candidate that the scorer's finder rule places on the item
//    counts, so a candidate about something else on its lines does not.
// 3. A drop's reason is lost, or one miss gets a cause per drop: the miss
//    has one cause, and every drop on it is kept with its reason and class.
// 4. A nitpick the reviewer raised on a planted bug, hidden by the
//    threshold, is labelled a scanner drop: the submission is read before
//    the drops.
// 5. A plant the reviewer disputes is labelled a spec error: only a
//    person's ruling makes spec-disputed; the reviewer's drop stays a drop.
// 6. A case only a person can decide is guessed: an unlisted finding is
//    unresolved until a person rules, and so is a miss while an unruled
//    finding may be it. And the reverse: a finding at an unlisted place
//    that shares a word with two truth items (admin) holds both misses
//    open; only a word no other truth item lists names an item there.
// 7. A miss whose lines the reviewer never had is blamed on its judgement:
//    the brief's diff, the delivered ranges and the reads are checked first;
//    when the trace is not complete (it records no reads), the reads are
//    unknown and those two checks are skipped rather than guessed.
// 8. A finding a correction round rejected reads as never raised: each
//    round's answer is read.
// 9. Absent data is read as evidence: a file the review did not save is
//    unknown, never empty. Without a complete trace, or with correction
//    rounds taken and no rounds.json, a place nothing else covers is not
//    known to be unseen; without submission.json no round's finding is
//    known to be left out; and a miss whose lines, proof, final answer or
//    rounds are not on record is unresolved, never judged wrong.
import { classifyReportDrops } from "./drops.mjs";
import { bugRuling, matchRuling, specHashOf } from "./rulings.mjs";
import { classify, locatedBy, names, normPath, normText, scannerPlaces, shownFindings } from "./score.mjs";

// Bump on any change to a rule below: a score records it beside the causes.
export const CAUSES_VERSION = 1;
export const MISS_CAUSES = Object.freeze(["incomplete", "spec-disputed", "not-in-brief", "not-read", "finalize-floor", "finalize-threshold", "finalize-rejected", "line-off", "wrong-kind", "unresolved", "candidate-dropped", "judged-wrong"]);
export const NON_HIT_CAUSES = Object.freeze(["real-unlisted", "line-off", "wrong-kind", "false", "unresolved"]);
// One line each, for the tables.
export const CAUSE_TEXT = Object.freeze({
  incomplete: "the review did not complete",
  "spec-disputed": "a person ruled the truth item wrong",
  "not-in-brief": "its lines were never in front of the reviewer",
  "not-read": "its proof outside the change was never read",
  "finalize-floor": "raised under the confidence floor",
  "finalize-threshold": "raised below the severity threshold, counted not listed",
  "finalize-rejected": "raised, rejected by a check, and left out",
  "line-off": "found but for its lines",
  "wrong-kind": "found but for its kind",
  unresolved: "waits for a person's ruling",
  "candidate-dropped": "a scanner candidate on it was dropped",
  "judged-wrong": "read, no candidate kept, nothing raised",
  "real-unlisted": "a person ruled it a real issue the truth does not list",
  false: "not a real issue, by a person's ruling or the spec",
});

// The non-hit cause of each outcome; hits, duplicates, accepted side issues
// and requests for a test set apart get none.
const BY_OUTCOME = { near: "line-off", "wrong-kind": "wrong-kind", "ruled-true": "real-unlisted", "ruled-false": "false", false: "false", unresolved: "unresolved" };

const FINDING_FIELDS = ["title", "problem", "consequence", "fix", "description", "suggested_change"];
const textOf = (f) => FINDING_FIELDS.map((k) => f?.[k]).filter((x) => typeof x === "string").join("\n").toLowerCase();
const placesOf = (bug) => [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])].map((l) => ({ file: normPath(l.file), lines: l.lines, side: bug.side ?? "right" }));
const overlaps = (ranges, [s, e]) => ranges.some(([a, b]) => a <= e && s <= b);
const push = (map, key, range) => map.set(key, [...(map.get(key) ?? []), range]);

// The line ranges a brief's unified diff shows, per side and file:
// { right: Map<path, [start, end][]>, left: ... }, from each hunk header,
// context lines included. Null when there is no brief.
export function briefRanges(brief) {
  if (typeof brief !== "string") return null;
  const out = { right: new Map(), left: new Map() };
  let oldPath = null;
  let newPath = null;
  let body = null;
  for (const line of brief.split("\n")) {
    if (body !== null) {
      const c = line === "" ? " " : line[0];
      if (c === " " || c === "-" || c === "+" || c === "\\") {
        if (c === " " || c === "-") body.old--;
        if (c === " " || c === "+") body.new--;
        if (body.old <= 0 && body.new <= 0) body = null;
        continue;
      }
      body = null;
    }
    let m;
    if ((m = /^--- (?:a\/)?(.+?)\s*$/.exec(line))) oldPath = m[1] === "/dev/null" ? null : normPath(m[1]);
    else if ((m = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line))) newPath = m[1] === "/dev/null" ? null : normPath(m[1]);
    else if ((m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line))) {
      const a = Number(m[1]);
      const b = m[2] === undefined ? 1 : Number(m[2]);
      const c = Number(m[3]);
      const d = m[4] === undefined ? 1 : Number(m[4]);
      if (newPath !== null && d > 0) push(out.right, newPath, [c, c + d - 1]);
      if (oldPath !== null && b > 0) push(out.left, oldPath, [a, a + b - 1]);
      body = b > 0 || d > 0 ? { old: b, new: d } : null;
    }
  }
  return out;
}

// What the saved files of an attempt record: the reads (a trace that is
// complete), the correction rounds (rounds.json, or a review that took none)
// and the final answer (submission.json). What is not recorded is unknown,
// never empty.
function recorded(a) {
  const taken = a?.report?.completion?.reviewer?.rounds;
  return {
    reads: Array.isArray(a?.trace) && a?.report?.completion?.trace_complete !== false,
    rounds: Array.isArray(a?.rounds) || (typeof taken === "number" && taken <= 1),
    taken: typeof taken === "number" ? taken - 1 : null,
    submission: Array.isArray(a?.submission?.findings),
  };
}

// Whether a place was in front of the reviewer: true when the brief's diff,
// a correction round's delivered range or a read covered one of its lines;
// false when none did and the brief, the reads and the rounds are all
// recorded; null when one of them is not (no saved brief, a trace that
// records no reads, or correction rounds taken with no rounds.json).
function sightings(a, known) {
  const brief = briefRanges(a?.brief ?? null);
  const reads = new Map();
  const delivered = { right: new Map(), left: new Map() };
  for (const t of Array.isArray(a?.trace) ? a.trace : []) if (t?.tool === "Read" && t.ok && t.inside === true && typeof t.path === "string" && Array.isArray(t.range)) push(reads, normPath(t.path), t.range);
  for (const r of Array.isArray(a?.rounds) ? a.rounds : []) for (const h of r?.delivered ?? []) push(h.deletion ? delivered.left : delivered.right, normPath(h.path), [h.start, h.end]);
  return (place) => {
    const side = place.side === "left" ? "left" : "right";
    if (brief !== null && overlaps(brief[side].get(place.file) ?? [], place.lines)) return true;
    if (overlaps(delivered[side].get(place.file) ?? [], place.lines)) return true;
    if (side === "right" && overlaps(reads.get(place.file) ?? [], place.lines)) return true;
    return brief === null || !known.reads || !known.rounds ? null : false;
  };
}

const where = (p) => `${p.file}:${p.lines[0]}${p.lines[1] > p.lines[0] ? `-${p.lines[1]}` : ""}`;
const findingKey = (f) => `${normPath(f?.file_path)}\0${f?.line_number}\0${normText(f?.title)}`;
const findingsOf = (answer) => (Array.isArray(answer?.findings) ? answer.findings.filter((f) => f && typeof f === "object") : []);

// The cause of one missed truth item, as { cause, why, drops? }.
function missCause({ bug, job, attempt, spec, specHash, rulings, sees, known, testOnly }) {
  if (job.status !== "complete") return { cause: "incomplete", why: job.status === "unstarted" ? "the planned review never started" : `the review is ${job.status}` };
  if (bugRuling(job.caseId, bug.id, specHash, rulings) === "disputed") return { cause: "spec-disputed", why: "a person ruled this truth item wrong in this spec version" };
  const places = placesOf(bug);
  const seen = places.map(sees);
  if (seen.every((s) => s === false)) return { cause: "not-in-brief", why: `no brief hunk, delivered range or read covered ${places.map(where).join(", ")}` };
  const proof = (bug.evidence ?? []).map((e) => ({ file: normPath(e.file), lines: e.lines, side: "right" }));
  const unread = proof.find((p) => sees(p) === false);
  if (unread) return { cause: "not-read", why: `its proof at ${where(unread)} was never read` };

  // What the reviewer submitted, set against what the report shows.
  const report = attempt?.report ?? null;
  const finds = (f) => {
    const c = classify(f, spec, { testOnly });
    return c.outcome === "hit" && c.bug === bug.id;
  };
  const listed = new Set(shownFindings(report).map(findingKey));
  const hidden = findingsOf(attempt?.submission).filter((f) => finds(f) && !listed.has(findingKey(f)));
  const low = new Map((report?.low_confidence ?? []).map((x) => [`${normPath(x.file_path)}\0${normText(x.title)}`, x]));
  const under = hidden.map((f) => [f, low.get(`${normPath(f.file_path)}\0${normText(f.title)}`)]).find(([, x]) => x !== undefined);
  if (under) return { cause: "finalize-floor", why: `"${under[0].title}" at confidence ${under[1].confidence}, under the floor ${under[1].floor}` };
  const counted = hidden.find((f) => !low.has(`${normPath(f.file_path)}\0${normText(f.title)}`));
  if (counted && (report?.below_threshold ?? 0) > 0) return { cause: "finalize-threshold", why: `"${counted.title}" rated ${counted.severity}, counted below the threshold` };
  // A round's finding is left out only of a final answer that was saved.
  const final = new Set(findingsOf(attempt?.submission).map(findingKey));
  for (const r of known.submission && Array.isArray(attempt?.rounds) ? attempt.rounds : []) {
    const gone = findingsOf(r?.answer).find((f) => finds(f) && !final.has(findingKey(f)));
    if (gone) return { cause: "finalize-rejected", why: `"${gone.title}" was in the answer of round ${r.round}, which failed: ${(r.errors ?? []).join("; ") || "no error named"}` };
  }

  // What the report shows.
  const near = job.findings.find((f) => f.outcome === "near" && f.bug === bug.id);
  if (near) return { cause: "line-off", why: `"${near.title}" at ${near.file}:${near.line}, ${near.distance} line${near.distance === 1 ? "" : "s"} off` };
  const kind = job.findings.find((f) => f.outcome === "wrong-kind" && f.bug === bug.id);
  if (kind) return { cause: "wrong-kind", why: `"${kind.title}" is ${kind.category}; the truth item is ${(bug.kind ?? []).join(" or ")}` };
  const shown = shownFindings(report);
  const files = new Set(places.map((p) => p.file));
  const open = job.findings.filter((f) => f.outcome === "unresolved");
  const onIt = open.find((f) => f.bug === bug.id);
  if (onIt) return { cause: "unresolved", why: `"${onIt.title}" sits on its lines and no person has ruled whether it is this issue` };
  // Only the item's own words count there: a word another truth item of the case lists too (admin) names neither.
  const shared = new Set((spec.bugs ?? []).filter((b) => b.id !== bug.id).flatMap((b) => b.mentions ?? []).map((w) => w.toLowerCase()));
  const own = (bug.mentions ?? []).filter((w) => !shared.has(w.toLowerCase()));
  const namesIt = open.find((f) => files.has(f.file) && (bug.kind ?? []).includes(f.category) && names(own, textOf(shown[f.index])) && matchRuling(f.findingId, bug.id, specHash, rulings)?.status !== "different-issue");
  if (namesIt) return { cause: "unresolved", why: `"${namesIt.title}" at ${namesIt.file}:${namesIt.line} names it at a place the spec does not list, and no person has ruled whether it is this issue` };

  // The scanner candidates the reviewer dropped that located it.
  const expected = bug.found_by ?? bug.expectedFinder ?? [];
  const drops = classifyReportDrops(report, attempt?.scan ?? null).filter((d) => d.candidate && typeof d.candidate === "object" && locatedBy(scannerPlaces({ candidates: [d.candidate] }), bug, expected).length > 0);
  if (drops.length > 0) return { cause: "candidate-dropped", why: drops.map((d) => `${d.candidate.token ?? d.candidate.id}: ${d.reason}`).join(" | "), drops: drops.map((d) => ({ candidate: d.candidate.id ?? null, token: d.candidate.token ?? null, reason: d.reason, class: d.class, tags: d.tags })) };
  // Judged wrong says the reviewer had the lines and raised nothing that finds
  // the item: each part must be on record, or the miss is unresolved.
  const unknown = [];
  if (!seen.includes(true)) unknown.push("whether its lines were in front of the reviewer");
  const proofUnknown = proof.find((p) => sees(p) === null);
  if (proofUnknown) unknown.push(`whether its proof at ${where(proofUnknown)} was read`);
  if (!known.submission) unknown.push("the final answer (no submission.json)");
  if (!known.rounds) unknown.push(`what ${known.taken === null ? "its correction rounds" : `its ${known.taken} correction round${known.taken === 1 ? "" : "s"}`} held (no rounds.json)`);
  if (unknown.length > 0) return { cause: "unresolved", why: `not recorded: ${unknown.join("; ")}` };
  return { cause: "judged-wrong", why: "its lines were in front of the reviewer, no dropped candidate located it, and nothing raised finds it" };
}

// The non-hit cause of one shown finding, as { cause, why }, or null for a
// hit, a duplicate, an accepted side issue or a request for a test.
function findingCause(f) {
  const cause = BY_OUTCOME[f.outcome] ?? null;
  if (cause === null) return null;
  const why = {
    near: () => `${f.distance} line${f.distance === 1 ? "" : "s"} from ${f.bug}`,
    "wrong-kind": () => `${f.category}, where ${f.bug} is another kind`,
    "ruled-true": () => "a person ruled it a real issue the truth does not list",
    "ruled-false": () => "a person ruled it not a real issue",
    false: () => "the spec decides it is false",
    unresolved: () => (f.bug ? `on the lines of ${f.bug}; no person has ruled on it` : "no truth item lists it and no person has ruled on it"),
  }[f.outcome]();
  return { cause, why };
}

// The causes of one scored job (lib/score.mjs scoreJob). `attempt` is its
// first attempt's saved files ({ report, submission, brief, trace, rounds,
// scan }, null when it never started), `spec` its case spec and `rulings`
// the rulings in force (lib/rulings.mjs resolveRulings). Returns { bugs:
// { <truth id>: cause or null }, findings: [cause or null, by index] }.
export function jobCauses({ job, attempt, spec, rulings }) {
  const known = recorded(attempt);
  const sees = sightings(attempt, known);
  const truth = new Map((spec.bugs ?? []).map((b) => [b.id, b]));
  const testOnly = job.origin === "planted";
  // A ruling on a truth item speaks for the spec version it judged only.
  const specHash = specHashOf(spec);
  const bugs = {};
  for (const b of job.bugs) bugs[b.id] = b.found ? null : missCause({ bug: truth.get(b.id), job, attempt, spec, specHash, rulings, sees, known, testOnly });
  return { bugs, findings: job.findings.map(findingCause) };
}

// The causes of a scored run: `jobs` from scoreAttempts, `attempts` as
// score.mjs loadRun reads them, `specs` by case name. Each miss and each
// counted non-hit is one row; byJob holds each job's causes.
export function runCauses({ jobs, attempts, specs, rulings }) {
  const key = (x) => `${x.case}\0${x.config}\0${x.repeat}`;
  const firsts = new Map(attempts.filter((a) => a.attempt === 1).map((a) => [key(a), a]));
  const byJob = new Map();
  const misses = [];
  const nonHits = [];
  for (const j of jobs) {
    const c = jobCauses({ job: j, attempt: firsts.get(key(j)) ?? null, spec: specs[j.case], rulings });
    byJob.set(j.jobId, c);
    const at = { jobId: j.jobId, caseId: j.caseId, case: j.case, config: j.config, repeat: j.repeat };
    for (const b of j.bugs) if (c.bugs[b.id]) misses.push({ ...at, bug: b.id, severity: b.severity, ...c.bugs[b.id] });
    j.findings.forEach((f, i) => {
      if (c.findings[i]) nonHits.push({ ...at, index: f.index, findingId: f.findingId, outcome: f.outcome, truthId: f.bug ?? null, title: f.title, place: `${f.file}:${f.line}`, ...c.findings[i] });
    });
  }
  return { version: CAUSES_VERSION, byJob, misses, nonHits };
}

// Counts by cause, every cause of the list named, zero or not.
export function countCauses(rows, list) {
  const out = Object.fromEntries(list.map((c) => [c, 0]));
  for (const r of rows) out[r.cause]++;
  return out;
}
