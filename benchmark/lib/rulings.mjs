// The adjudication file, benchmark/review-queue/decisions.jsonl: what a
// person ruled on the findings and truth items that no frozen spec decides.
// queue.mjs decide is its only writer. score.mjs reads it through
// lib/score.mjs, so the rules hash covers how a ruling is read and applied;
// queue.mjs reads it to know which questions are still open.
//
// One line per ruling, appended, never edited:
//   { v: 1, caseId, specsFrom? (legacy runs only), fromSheet, target, status,
//     by, at, note, evidence: { text, lines, sha256 } | null }
// The target and the statuses it takes:
//   { kind: "bug", id }                    confirmed | disputed
//   { kind: "finding", findingId }         true | false
//   { kind: "issue", issueId, members }    consolidate | true | false
//   { kind: "match", findingId, truthId }  same-issue | different-issue
//   { kind: "case" }                       clean | not-clean
//
// Failure list, written before the code:
// 1. A ruling without a person's name changes a score: a line whose `by` is
//    missing, empty, or names a model, an agent or a tool is ignored, and
//    reported with its line number and the reason.
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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const STATUSES = Object.freeze({
  bug: ["confirmed", "disputed"],
  finding: ["true", "false"],
  issue: ["consolidate", "true", "false"],
  match: ["same-issue", "different-issue"],
  case: ["clean", "not-clean"],
});

// Words that name a model, an agent or a tool, never a person.
export const NOT_A_PERSON = ["agent", "ai", "anonymous", "anthropic", "assistant", "astra", "bot", "builder", "ci", "claude", "cline", "codex", "copilot", "cursor", "fable", "gemini", "gpt", "haiku", "judge", "llm", "luna", "model", "none", "null", "openai", "opus", "script", "scripted", "session", "sol", "sonnet", "terra", "undefined", "unknown"];

// A person's name: at least one word of letters, and no word that names a
// model, an agent or a tool.
export function isPersonName(by) {
  if (typeof by !== "string") return false;
  const words = by.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => !NOT_A_PERSON.includes(w));
}

const HEX64 = /^[0-9a-f]{64}$/;
const isText = (s) => typeof s === "string" && s.trim() !== "";

// What keeps one line from being a ruling, as reasons; empty when it is one.
export function rulingProblems(l) {
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
  if (t.kind === "issue") {
    const prefix = `${l.caseId}#I`;
    if (typeof t.issueId !== "string" || !t.issueId.startsWith(prefix) || !/^[1-9]\d*$/.test(t.issueId.slice(prefix.length))) p.push("issueId must be <caseId>#I<n>, of this line's case");
    const members = Array.isArray(t.members) ? t.members : [];
    if (l.status === "consolidate" && !(members.length >= 2 && members.every((m) => HEX64.test(String(m))) && new Set(members).size === members.length)) p.push("a consolidate line names two or more distinct findingIds as members");
  }
  if (!isPersonName(l.by)) p.push(`by must name the person who ruled, not ${JSON.stringify(l.by ?? null)}: a model or an agent never rules`);
  if (typeof l.at !== "string" || Number.isNaN(Date.parse(l.at))) p.push("at must be a time");
  return p;
}

// The rulings in force, from the file's lines in order (each a parsed line,
// or null for a line that is not JSON): the latest ruling per target, the
// issue each finding belongs to, and every ignored line with its reason.
export function resolveRulings(lines = []) {
  const R = { read: 0, ignored: [], findings: new Map(), issues: new Map(), members: new Map(), grouped: new Set(), matches: new Map(), bugs: new Map(), cases: new Map() };
  for (const [i, l] of lines.entries()) {
    const n = i + 1;
    R.read++;
    const problems = l === null ? ["it is not JSON"] : rulingProblems(l);
    if (problems.length > 0) {
      R.ignored.push({ line: n, why: problems.join("; ") });
      continue;
    }
    const t = l.target;
    const at = { status: l.status, n };
    if (t.kind === "finding") R.findings.set(t.findingId, at);
    else if (t.kind === "match") {
      if (!R.matches.has(t.findingId)) R.matches.set(t.findingId, new Map());
      R.matches.get(t.findingId).set(t.truthId, at);
    } else if (t.kind === "bug") R.bugs.set(`${l.caseId}\0${t.id}`, at);
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

// The person's ruling on whether a finding is a given truth item, or null.
export const matchRuling = (findingId, truthId, R) => R.matches.get(findingId)?.get(truthId) ?? null;

// The truth item, among `ids` (its case's), that a person ruled a finding
// to be ({ truthId, n }, the latest standing same-issue ruling), or null.
export function sameIssueAs(findingId, ids, R) {
  let best = null;
  for (const [truthId, at] of R.matches.get(findingId) ?? []) if (at.status === "same-issue" && ids.includes(truthId) && (best === null || at.n > best.n)) best = { truthId, n: at.n };
  return best;
}

// A person's ruling on a truth item of a case (confirmed or disputed), or null.
export const bugRuling = (caseId, bugId, R) => R.bugs.get(`${caseId}\0${bugId}`)?.status ?? null;

// The file's lines, parsed (null for one that is not JSON), and its sha256
// (null when there is no file yet).
export function readDecisions(path) {
  if (!existsSync(path)) return { hash: null, lines: [] };
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
  return { hash: createHash("sha256").update(bytes).digest("hex"), lines: raw.map(parse) };
}
