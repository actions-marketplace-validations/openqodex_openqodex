// The completion record of a review run by `review` itself, and the
// coverage it is built from. Coverage comes from the reviewer's trace (the
// tool calls its agent reported), never from the reviewer's own word: a
// changed range counts as given to the reviewer when its file's diff was in
// the brief, or when successful reads cover every line of it. A deletion has
// no line in the snapshot, so only the diff in the brief can show it.
import type { Change, CompletionRecord, ReviewerRecord } from "./types.js";

// One tool call of the reviewer. `path` is relative to the snapshot when
// `inside`, else as the agent named it. `range` is the first and last line a
// read delivered.
export type TraceEntry = { tool: string; path: string | null; inside: boolean; range: [number, number] | null; ok: boolean };

export type Hunk = { path: string; start: number; end: number; deletion: boolean };

export type Coverage = CompletionRecord["coverage"];

// The tools a reviewer is given. Anything else in a trace fails the run.
export const REVIEWER_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

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

export function readCoverage(args: { change: Change; briefFiles: ReadonlySet<string>; trace: TraceEntry[] }): Coverage {
  const reads = new Map<string, [number, number][]>();
  for (const t of args.trace) {
    if (t.tool !== "Read" || !t.ok || !t.inside || t.path === null || t.range === null) continue;
    reads.set(t.path, [...(reads.get(t.path) ?? []), t.range]);
  }
  const read = (path: string, n: number) => (reads.get(path) ?? []).some(([a, b]) => a <= n && n <= b);
  const hunks = changedHunks(args.change);
  const unread = hunks.filter((h) => {
    if (args.briefFiles.has(h.path)) return false;
    if (h.deletion) return true;
    for (let n = h.start; n <= h.end; n++) if (!read(h.path, n)) return true;
    return false;
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
}): CompletionRecord {
  const missing: string[] = [];
  if (args.reviewer === null) missing.push("no reviewer process was started by openqodex");
  if (args.failure) missing.push(args.failure);
  if (args.snapshot.after === null || args.snapshot.after !== args.snapshot.before) {
    missing.push("the snapshot changed while the reviewer read it");
  }
  // Fails closed: an attempt counts, whether or not the agent's own rules refused it.
  const outside = [...new Set(args.trace.filter((t) => !t.inside).map((t) => t.path ?? "(no path)"))];
  if (outside.length > 0) missing.push(`the reviewer tried to read outside the snapshot: ${listed(outside)}`);
  const tools = [...new Set(args.trace.map((t) => t.tool).filter((t) => !REVIEWER_TOOLS.includes(t)))];
  if (tools.length > 0) missing.push(`the reviewer used a tool it was not given: ${tools.join(", ")}`);
  const open = args.candidates.total - args.candidates.disposed;
  if (open > 0) missing.push(`${open} scanner ${open === 1 ? "candidate has" : "candidates have"} no disposition`);
  if (args.submissionErrors.length > 0) {
    const n = args.submissionErrors.length;
    missing.push(`the reviewer's answer still failed ${n} ${n === 1 ? "check" : "checks"} after the correction rounds`, ...args.submissionErrors.slice(0, MAX_LISTED));
  }
  if (!args.wholeRepo && args.coverage.unread.length > 0) {
    const n = args.coverage.unread.length;
    missing.push(`${n} changed ${n === 1 ? "range was" : "ranges were"} not read: ${listed(args.coverage.unread.map(where))}`);
  }
  return {
    version: 1,
    contract: "openqodex-review-2",
    status: missing.length === 0 ? "complete" : "incomplete",
    missing,
    reviewer: args.reviewer,
    snapshot: { change_id: args.change.id, ...args.snapshot },
    candidates: args.candidates,
    coverage: args.coverage,
    outside_reads: outside,
  };
}
