// The adjudication file, benchmark/review-queue/decisions.jsonl: what a
// person ruled on the findings and truth items that no frozen spec decides.
// queue.mjs decide is its only writer. score.mjs reads it through
// lib/score.mjs, so the rules hash covers how a ruling is read and applied;
// queue.mjs reads it to know which questions are still open.
//
// One line per ruling, appended, never edited:
//   { v: 1, caseId, specsFrom? (the --specs folder the spec came from, for a
//     reader), fromSheet, target, status,
//     by, at, note, evidence: { text, lines, sha256 } | null }
// The target and the statuses it takes:
//   { kind: "bug", id, specHash }                    confirmed | disputed
//   { kind: "finding", findingId }                   true | false
//   { kind: "issue", issueId, members }              consolidate | true | false
//   { kind: "match", findingId, truthId, specHash }  same-issue | different-issue
//   { kind: "case" }                                 clean | not-clean
// A ruling on a truth item (bug and match) names the version of the spec it
// judged: specHash is the sha256 of that spec (specHashOf), the spec the
// run was scored against when the person ruled.
// On a finding or an issue, spec-candidate-accepted and
// spec-candidate-rejected (the reviewer part's names for a spec candidate)
// are true and false.
//
// Who may rule: people.json beside the adjudication file, { v: 1, people:
// [names] }, written by hand and reviewed like any other change.
//
// Failure list, written before the code:
// 1. A ruling without a person's name changes a score: a line whose `by` is
//    missing, empty, names a model, an agent or a tool, or is not a name in
//    people.json is ignored, and reported with its line number and the
//    reason. A name that passes a word list alone (ChatGPT, or any made-up
//    name) is not enough: the name must be on the list of people, and the
//    word list still refuses a model's name put on that list.
// 2. Two findings become one issue by overlap, category, rule or
//    recurrence: only a person's consolidate line makes an issue, and only
//    of the findings it names; an issue ruling with no such line before it
//    is ignored.
// 3. A ruling on one finding reaches another on the same lines: rulings key
//    on the findingId (the case, the lines and the text), never on a place.
// 4. A person changes their mind and the first ruling still counts: the
//    latest line for a target wins, and a finding in an issue takes
//    whichever of its own ruling and its issue's ruling came later. A later
//    consolidate line for an issue replaces its members.
// 5. A malformed line (not JSON, a status its target cannot take, a finding
//    id that is not a sha256, an issue id of another case) is read as a
//    ruling: it is ignored and reported.
// 6. A ruling on a truth item reaches another version of its case's spec
//    (issue 163: permit-all was wrong in one version and right in the
//    next): a bug or match ruling applies only where the spec a run is
//    scored against has the specHash it names. A legacy run's case id names
//    no version, and a run scored with --specs reads other truth than its
//    own, so the case id alone cannot tell. A line that names no specHash
//    applies to no version: it is ignored and reported.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Whether a finding or an issue is a real issue, by each status that says so.
export const REAL = Object.freeze({ true: "true", false: "false", "spec-candidate-accepted": "true", "spec-candidate-rejected": "false" });

export const STATUSES = Object.freeze({
  bug: ["confirmed", "disputed"],
  finding: Object.keys(REAL),
  issue: ["consolidate", ...Object.keys(REAL)],
  match: ["same-issue", "different-issue"],
  case: ["clean", "not-clean"],
});

// Words that name a model, an agent or a tool, never a person.
export const NOT_A_PERSON = ["agent", "ai", "anonymous", "anthropic", "assistant", "astra", "bot", "builder", "chatgpt", "ci", "claude", "cline", "codex", "copilot", "cursor", "fable", "gemini", "gpt", "haiku", "judge", "llm", "luna", "model", "none", "null", "openai", "opus", "script", "scripted", "session", "sol", "sonnet", "terra", "undefined", "unknown"];

// A person who may rule: a name on the list of people (people.json), with
// no word that names a model, an agent or a tool.
export function isPersonName(by, people = []) {
  if (typeof by !== "string") return false;
  const words = by.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length === 0 || words.some((w) => NOT_A_PERSON.includes(w))) return false;
  const name = by.trim().toLowerCase();
  return people.some((p) => typeof p === "string" && p.trim().toLowerCase() === name);
}

const HEX64 = /^[0-9a-f]{64}$/;

// JSON with the keys of every object in sorted order, so a spec's version
// does not depend on how its file orders them.
function sortedJson(v) {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// The version of a spec a ruling on one of its truth items names: the
// sha256 of its JSON, keys sorted.
export const specHashOf = (spec) => createHash("sha256").update(sortedJson(spec)).digest("hex");
const isText = (s) => typeof s === "string" && s.trim() !== "";

// What keeps one line from being a ruling, as reasons; empty when it is one.
// `people` are the names in people.json.
export function rulingProblems(l, people = []) {
  if (!l || typeof l !== "object" || Array.isArray(l)) return ["it is not a JSON object"];
  const p = [];
  if (l.v !== 1) p.push("v must be 1");
  if (!isText(l.caseId)) p.push("caseId is missing");
  const t = l.target && typeof l.target === "object" ? l.target : {};
  const statuses = STATUSES[t.kind];
  if (!statuses) p.push(`target.kind must be one of ${Object.keys(STATUSES).join(", ")}`);
  else if (!statuses.includes(l.status)) p.push(`a ${t.kind} ruling takes ${statuses.join(", ")}, not ${JSON.stringify(l.status ?? null)}`);
  if (t.kind === "bug" && !isText(t.id)) p.push("a bug ruling names the truth item's id");
  if ((t.kind === "finding" || t.kind === "match") && !HEX64.test(String(t.findingId))) p.push("findingId must be a sha256");
  if (t.kind === "match" && !isText(t.truthId)) p.push("a match ruling names the truth item's id");
  if ((t.kind === "bug" || t.kind === "match") && !HEX64.test(String(t.specHash))) p.push(`a ${t.kind} ruling names the spec version it judged as target.specHash, the sha256 of that spec, so it never reaches another version; record it again with queue.mjs decide`);
  if (t.kind === "issue") {
    const prefix = `${l.caseId}#I`;
    if (typeof t.issueId !== "string" || !t.issueId.startsWith(prefix) || !/^[1-9]\d*$/.test(t.issueId.slice(prefix.length))) p.push("issueId must be <caseId>#I<n>, of this line's case");
    const members = Array.isArray(t.members) ? t.members : [];
    if (l.status === "consolidate" && !(members.length >= 2 && members.every((m) => HEX64.test(String(m))) && new Set(members).size === members.length)) p.push("a consolidate line names two or more distinct findingIds as members");
  }
  if (!isPersonName(l.by, people)) p.push(`by must name a person listed in people.json beside the adjudication file, not ${JSON.stringify(l.by ?? null)}: a model or an agent never rules`);
  if (typeof l.at !== "string" || Number.isNaN(Date.parse(l.at))) p.push("at must be a time");
  return p;
}

// The rulings in force, from the file's lines in order (each a parsed line,
// or null for a line that is not JSON) and the names in people.json: the
// latest ruling per target, the issue each finding belongs to, and every
// ignored line with its reason. A finding or issue ruling is kept as true
// or false, whichever name it was written under. A bug or match ruling is
// kept under the spec version it names.
export function resolveRulings(lines = [], people = []) {
  const R = { read: 0, ignored: [], people: [...people], findings: new Map(), issues: new Map(), members: new Map(), grouped: new Set(), matches: new Map(), bugs: new Map(), cases: new Map() };
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    R.read++;
    const problems = l === null ? ["it is not JSON"] : rulingProblems(l, people);
    if (problems.length > 0) {
      R.ignored.push({ line: n, why: problems.join("; ") });
      continue;
    }
    const t = l.target;
    const at = { status: REAL[l.status] ?? l.status, n };
    if (t.kind === "finding") R.findings.set(t.findingId, at);
    else if (t.kind === "match") {
      if (!R.matches.has(t.findingId)) R.matches.set(t.findingId, new Map());
      R.matches.get(t.findingId).set(`${t.specHash}\0${t.truthId}`, { ...at, truthId: t.truthId, specHash: t.specHash });
    } else if (t.kind === "bug") R.bugs.set(`${l.caseId}\0${t.specHash}\0${t.id}`, at);
    else if (t.kind === "case") R.cases.set(l.caseId, at);
    else if (l.status === "consolidate") {
      for (const [f, issue] of R.members) if (issue === t.issueId) R.members.delete(f);
      for (const f of t.members) R.members.set(f, t.issueId);
      R.grouped.add(t.issueId);
    } else if (!R.grouped.has(t.issueId)) R.ignored.push({ line: n, why: `no person consolidated ${t.issueId} on an earlier line` });
    else R.issues.set(t.issueId, at);
  }
  return R;
}

// The issue a person put a finding in, or null.
export const issueOf = (findingId, R) => R.members.get(findingId) ?? null;

// A finding's ruling on whether it is a real issue ({ status, n }): the
// later of its own and its issue's, or null when there is neither.
export function realRuling(findingId, R) {
  const own = R.findings.get(findingId) ?? null;
  const issueId = issueOf(findingId, R);
  const viaIssue = issueId === null ? null : (R.issues.get(issueId) ?? null);
  if (own === null || viaIssue === null) return own ?? viaIssue;
  return own.n > viaIssue.n ? own : viaIssue;
}

// The person's ruling on whether a finding is a given truth item of the
// spec version `specHash`, or null.
export const matchRuling = (findingId, truthId, specHash, R) => R.matches.get(findingId)?.get(`${specHash}\0${truthId}`) ?? null;

// The truth item, among `ids` (its case's, in the spec version
// `specHash`), that a person ruled a finding to be ({ truthId, n }, the
// latest standing same-issue ruling on that version), or null.
export function sameIssueAs(findingId, ids, specHash, R) {
  let best = null;
  for (const at of R.matches.get(findingId)?.values() ?? []) if (at.status === "same-issue" && at.specHash === specHash && ids.includes(at.truthId) && (best === null || at.n > best.n)) best = { truthId: at.truthId, n: at.n };
  return best;
}

// A person's ruling on a truth item of a case in the spec version
// `specHash` (confirmed or disputed), or null.
export const bugRuling = (caseId, bugId, specHash, R) => R.bugs.get(`${caseId}\0${specHash}\0${bugId}`)?.status ?? null;

// The names in the people.json of a folder: { v: 1, people: [names] }.
// None when the file is missing or not that shape, so no ruling counts.
export function readPeople(folder) {
  try {
    const doc = JSON.parse(readFileSync(join(folder, "people.json"), "utf8"));
    return doc?.v === 1 && Array.isArray(doc.people) ? doc.people.filter((p) => typeof p === "string" && p.trim() !== "") : [];
  } catch {
    return [];
  }
}

// The file's lines, parsed (null for one that is not JSON), its sha256
// (null when there is no file yet), and the people who may rule, from the
// people.json beside it.
export function readDecisions(path) {
  const people = readPeople(dirname(path));
  if (!existsSync(path)) return { hash: null, lines: [], people };
  const bytes = readFileSync(path);
  const raw = bytes.toString("utf8").split("\n");
  if (raw.at(-1) === "") raw.pop();
  const parse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  return { hash: createHash("sha256").update(bytes).digest("hex"), lines: raw.map(parse), people };
}

// A person's standing ruling on a scanner candidate (the review queue's
// candidate items, keyed on lib/scan-score.mjs candidateIdOf) in the spec
// version `specHash` (specHashOf), from the file's lines in order and the
// people who may rule. A candidate's truth depends on the spec it is
// scored against: a revised spec may list an issue on its lines. queue.mjs
// decide writes a candidate's ruling as a finding or match ruling whose
// target also says candidate: true and names that version (specHash). So
// only a finding or match ruling on the candidate itself that names that
// version (target.specHash) counts; one naming another version, or none, is
// refused, with its line and the reason. Returns { status, truthId,
// answered, refused }: status "true" or "false" on whether it is a real
// issue, "same-issue" (truthId the item) when a person ruled it the truth
// item it sits on, the later of the two when both stand, or null (a
// different-issue ruling alone says only what the candidate is not);
// answered, the truth items a match ruling on this version answers.
export function candidateRuling(candidateId, specHash, { lines = [], people = [] } = {}) {
  let real = null;
  const matches = new Map();
  const refused = [];
  for (const [i, l] of lines.entries()) {
    const t = l?.target;
    if (!t || t.findingId !== candidateId || (t.kind !== "finding" && t.kind !== "match") || rulingProblems(l, people).length > 0) continue;
    if (t.specHash !== specHash) {
      refused.push({ line: i + 1, why: `it names ${HEX64.test(String(t.specHash)) ? `another version of the case's spec (${t.specHash.slice(0, 12)}, the run's is ${String(specHash).slice(0, 12)})` : "no version of the case's spec"}, so a person rules it again on the sheet` });
      continue;
    }
    if (t.kind === "finding") real = { status: REAL[l.status], n: i + 1 };
    else matches.set(t.truthId, { status: l.status, n: i + 1 });
  }
  let same = null;
  for (const [truthId, at] of matches) if (at.status === "same-issue" && (same === null || at.n > same.n)) same = { truthId, n: at.n };
  const answered = [...matches.keys()];
  if (same !== null && (real === null || same.n > real.n)) return { status: "same-issue", truthId: same.truthId, answered, refused };
  return { status: real?.status ?? null, truthId: null, answered, refused };
}
