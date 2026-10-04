// Turns the tool calls a driver reports into trace entries, deciding by
// script, never by the driver, whether each call stayed inside the snapshot.
// It fails closed: a call whose input cannot be read, a path that cannot be
// placed (a `$` or `%` in it, a NUL), or any path-bearing field that leaves
// the snapshot marks the whole call as outside. The agent's own permission
// rules are the boundary; this check is the alarm that fails the run when
// the trace shows the boundary was not where it should be.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TraceEntry } from "@openqodex/core";

// What a driver saw for one tool call: its name, its input as the agent sent
// it, whether it succeeded, and for a read what was delivered.
export type ToolCall = { tool: string; input: unknown; ok: boolean; read: { path: string; start: number; lines: number } | null };

// Input fields that name a path, and those that hold a file pattern. Grep's
// `pattern` is the expression it searches for, not a path, so for Grep only
// `glob` is a file pattern.
const PATH_FIELDS = ["file_path", "path", "notebook_path", "cwd", "directory"];
const PATTERN_FIELDS = ["pattern", "glob"];
const GREP_PATTERN_FIELDS = ["glob"];

const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

// The real path of `abs`: the deepest part that exists, resolved through
// links, with the rest appended.
function realDeep(abs: string): string {
  let head = abs;
  const rest: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    rest.unshift(head.slice(up.length).replace(/^[\\/]/, ""));
    head = up;
  }
  let real = head;
  try {
    real = realpathSync(head);
  } catch {
    // unreadable: compared as written
  }
  return rest.length > 0 ? join(real, ...rest) : real;
}

function within(root: string, path: string): boolean {
  const a = FOLD_CASE ? root.toLowerCase() : root;
  const b = FOLD_CASE ? path.toLowerCase() : path;
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

// A file pattern that may reach outside, or the folder an absolute one is
// rooted in. `..` anywhere, a home pattern, and an alternative list that
// holds a path (`{../a/*,*.ts}`) are outside whatever else they say. An
// absolute pattern is rooted at the last folder before its first wildcard:
// `/a/snap*/x` is rooted at `/a/`, since `snap*` also matches `snapshot-2`.
// Null for a relative pattern with none of these: it stays below its folder.
function patternRoot(pattern: string): string | null {
  const outside = "/";
  if (pattern.includes("..") || pattern.startsWith("~") || (pattern.includes("{") && /[\\/]/.test(pattern))) return outside;
  if (!(pattern.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pattern))) return null;
  const cut = pattern.search(/[*?[{]/);
  if (cut === -1) return pattern;
  const slash = Math.max(pattern.lastIndexOf("/", cut), pattern.lastIndexOf("\\", cut));
  return pattern.slice(0, slash + 1) || outside;
}

// Each raw path placed: its real form, or null when it cannot be placed.
function place(snapshot: string, raw: string): string | null {
  if (raw.includes("\0") || raw.includes("$") || raw.includes("%")) return null;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw.startsWith("~") ? null : raw;
  if (expanded === null) return null;
  return realDeep(resolve(snapshot, expanded));
}

export function classify(snapshotDir: string, call: ToolCall): TraceEntry {
  let snapshot = snapshotDir;
  try {
    snapshot = realpathSync(snapshotDir);
  } catch {
    // compared as given
  }
  const range: [number, number] | null = call.read && call.read.lines > 0 ? [call.read.start, call.read.start + call.read.lines - 1] : null;
  const input = call.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { tool: call.tool, path: "(a tool input that could not be read)", inside: false, range: null, ok: true };
  }
  const fields = input as Record<string, unknown>;
  const raws: string[] = [];
  for (const k of PATH_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    raws.push(fields[k] as string);
  }
  for (const k of call.tool === "Grep" ? GREP_PATTERN_FIELDS : PATTERN_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    const root = patternRoot(fields[k] as string);
    if (root !== null) raws.push(root);
  }
  if (call.read) raws.push(call.read.path);
  if (call.tool === "Read" && typeof fields.file_path !== "string") {
    return { tool: call.tool, path: "(a read with no file_path)", inside: false, range: null, ok: true };
  }
  for (const raw of raws) {
    const real = place(snapshot, raw);
    if (real === null || !within(snapshot, real)) return { tool: call.tool, path: raw, inside: false, range, ok: call.ok };
  }
  const first = raws[0] ?? null;
  const real = first === null ? null : place(snapshot, call.read?.path ?? first);
  const rel = real === null ? null : relative(FOLD_CASE ? snapshot.toLowerCase() : snapshot, FOLD_CASE ? real.toLowerCase() : real) === "" ? "." : real.slice(snapshot.length + 1);
  return { tool: call.tool, path: rel, inside: true, range, ok: call.ok };
}
