// The completion record of a review run by `review` itself, and the
// coverage it is built from. Coverage comes from the reviewer's trace (the
// tool calls its agent reported), never from the reviewer's own word: a
// changed range counts as given to the reviewer when its file's diff was in
// the brief, when the run put it in a correction round, or when successful
// reads cover every line of it. A deletion has no line in the snapshot, so
// only the diff in the brief or a correction round can show it. A reviewer
// whose trace is not complete (Codex) reports no reads, so for it only the
// brief and the correction rounds count.
import type { Change, CompletionRecord, ReviewerRecord } from "./types.js";

// One tool call of the reviewer. `path` is relative to the snapshot when
// `inside`, else as the agent named it. `range` is the first and last line a
// read delivered. For a reviewer whose trace is not complete (Codex),
// `inside` is null (not checked) and `detail` holds the call's input as
// reported (a command, a search), kept as a diagnostic only. `own`: a call
// outside the snapshot on the agent's own saved output of this session
// (Claude Code's tool-results folder), which reads no repository file.
export type TraceEntry = { tool: string; path: string | null; inside: boolean | null; range: [number, number] | null; ok: boolean; detail?: string; own?: true };

// Whether a call left the snapshot: anything not shown inside it, except the
// agent's own saved output of this session.
export function outsideSnapshot(t: TraceEntry): boolean {
  return t.inside !== true && t.own !== true;
}

export type Hunk = { path: string; start: number; end: number; deletion: boolean };

export type Coverage = CompletionRecord["coverage"];

// The tools a reviewer is given. Anything else in a trace fails the run.
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
// Added unless the user config sets `reviewer_web: off`.
export const REVIEWER_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

// Shown in `missing`, so a long list stays readable.
const MAX_LISTED = 10;

// Every changed range of the change: runs of added or modified lines, and
// each deletion point as the lines on either side of it.
export function changedHunks(change: Change): Hunk[] {
  const hunks: Hunk[] = [];
  for (const [path, lines] of change.coverage) {
    let start = -1;
    let prev = -1;
    for (const n of [...lines].sort((a, b) => a - b)) {
      if (n !== prev + 1) {
        if (start !== -1) hunks.push({ path, start, end: prev, deletion: false });
        start = n;
      }
      prev = n;
    }
    if (start !== -1) hunks.push({ path, start, end: prev, deletion: false });
  }
  for (const [path, points] of change.deletionPoints) {
    for (const p of points) hunks.push({ path, start: Math.min(...p.anchors), end: Math.max(...p.anchors), deletion: true });
  }
  return hunks;
}

// Whether the reads cover every line from `start` to `end`.
function covers(ranges: [number, number][], start: number, end: number): boolean {
  let next = start;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a > next) break;
    next = Math.max(next, b + 1);
    if (next > end) return true;
  }
  return next > end;
}

// `lineCount`: a file's line count in the snapshot, or null when it cannot be
// told. A file the change could not map (Change.uncovered) is one range from
// its first line to its last, read only when reads cover all of it; with no
// line count it can never be shown read.
// `delivered`: ranges the tool itself put in front of the reviewer in a
// correction round; a line range counts like a read, a deletion when the
// same deletion was delivered.
export function readCoverage(args: { change: Change; briefFiles: ReadonlySet<string>; trace: TraceEntry[]; lineCount?: (path: string) => number | null; delivered?: Hunk[] }): Coverage {
  const reads = new Map<string, [number, number][]>();
  for (const t of args.trace) {
    if (t.tool !== "Read" || !t.ok || t.inside !== true || t.path === null || t.range === null) continue;
    reads.set(t.path, [...(reads.get(t.path) ?? []), t.range]);
  }
  const given = new Map<string, [number, number][]>();
  const deletions = new Set<string>();
  for (const d of args.delivered ?? []) {
    if (d.deletion) deletions.add(`${d.path}\0${d.start}\0${d.end}`);
    else given.set(d.path, [...(given.get(d.path) ?? []), [d.start, d.end]]);
  }
  const whole = (args.change.uncovered ?? []).map((path) => ({ path, start: 1, end: args.lineCount?.(path) ?? 0, deletion: false }));
  const hunks = [...changedHunks(args.change), ...whole];
  const unread = hunks.filter((h) => {
    if (args.briefFiles.has(h.path)) return false;
    if (h.deletion) return !deletions.has(`${h.path}\0${h.start}\0${h.end}`);
    if (h.end < h.start) return true;
    return !covers([...(reads.get(h.path) ?? []), ...(given.get(h.path) ?? [])], h.start, h.end);
  });
  const readable = args.change.files.filter((f) => f.status !== "deleted" && !f.binary).map((f) => f.path);
  return {
    hunks: hunks.length,
    covered: hunks.length - unread.length,
    unread,
    files_read: [...reads.keys()].sort(),
    files_not_read: readable.filter((p) => !reads.has(p)).sort(),
  };
}

const where = (h: Hunk) => (h.end > h.start ? `${h.path}:${h.start}-${h.end}` : `${h.path}:${h.start}`);

function listed(items: string[]): string {
  const more = items.length - MAX_LISTED;
  return items.slice(0, MAX_LISTED).join(", ") + (more > 0 ? ` and ${more} more` : "");
}

export function completionRecord(args: {
  change: Change;
  reviewer: ReviewerRecord | null;
  snapshot: { tree: string | null; before: string; after: string | null };
  candidates: { total: number; disposed: number };
  coverage: Coverage;
  trace: TraceEntry[];
  // The numbered rejections the last answer still had; empty when it passed.
  submissionErrors: string[];
  // `review --all`: no changed ranges, so coverage is reported, never required.
  wholeRepo: boolean;
  // Why the reviewer gave no answer that could be checked (it timed out, it
  // exited, it started with more than it was given).
  failure?: string | null;
  // The tools the reviewer was given; REVIEWER_TOOLS when left out.
  tools?: readonly string[];
  // False when the reviewer's event stream does not show every tool call
  // (Codex): the trace is then a diagnostic list, and neither its paths nor
  // its tool names can complete or fail the review. True when left out.
  traced?: boolean;
}): CompletionRecord {
  const traced = args.traced ?? true;
  const missing: string[] = [];
  if (args.reviewer === null) missing.push("no reviewer process was started by openqodex");
  if (args.failure) missing.push(args.failure);
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) {
    missing.push("the snapshot changed while the reviewer read it");
  }
  // Fails closed: an attempt counts, whether or not the agent's own rules refused it.
  const outside = traced ? [...new Set(args.trace.filter(outsideSnapshot).map((t) => t.path ?? "(no path)"))] : [];
  if (outside.length > 0) missing.push(`the reviewer tried to read outside the snapshot: ${listed(outside)}`);
  const given = args.tools ?? REVIEWER_TOOLS;
  const tools = traced ? [...new Set(args.trace.map((t) => t.tool).filter((t) => !given.includes(t)))] : [];
  if (tools.length > 0) missing.push(`the reviewer used a tool it was not given: ${tools.join(", ")}`);
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) missing.push(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (!args.wholeRepo && args.coverage.unread.length > 0) {
    const n = args.coverage.unread.length;
    missing.push(`${n} changed ${n === 1 ? "range was" : "ranges were"} ${traced ? "not read" : "not given to the reviewer"}: ${listed(args.coverage.unread.map(where))}`);
  }
  return {
    version: 1,
    contract: "openqodex-review-2",
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    reviewer: args.reviewer,
    snapshot: { change_id: args.change.id, ...args.snapshot },
    candidates: args.candidates,
    // Reads were not measured without a complete trace: no file is listed as read or not read.
    coverage: traced ? args.coverage : { ...args.coverage, files_read: [], files_not_read: [] },
    outside_reads: outside,
    trace_complete: traced,
  };
}
