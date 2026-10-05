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

// The most alternatives a file pattern's brace lists may expand to before the
// check gives up and marks the call outside: `{a,b}` ten times over is 1024.
const MAX_PATTERN_ALTERNATIVES = 256;

// Every alternative a file pattern's brace lists name, nested lists included:
// `{src,lib/{a,b}}/*.ts` is `src/*.ts`, `lib/a/*.ts` and `lib/b/*.ts`. A
// backslash escapes the next character, as the glob engines of macOS and
// Linux read it, and is kept in the alternative. Null when the braces do not
// balance or the alternatives would number more than MAX_PATTERN_ALTERNATIVES.
function alternatives(pattern: string): string[] | null {
  let i = 0;
  // One alternative's text up to a `,` or `}` of the list it is in, or to the
  // end of the pattern at the top level, where a `,` is plain text.
  const sequence = (inList: boolean): string[] | null => {
    let out = [""];
    while (i < pattern.length) {
      const c = pattern[i]!;
      if (c === "\\") {
        const escaped = pattern.slice(i, i + 2);
        out = out.map((s) => s + escaped);
        i += 2;
      } else if (c === "{") {
        i++;
        const listed = list();
        if (listed === null || out.length * listed.length > MAX_PATTERN_ALTERNATIVES) return null;
        out = out.flatMap((s) => listed.map((l) => s + l));
      } else if (c === "}" || (c === "," && inList)) {
        return inList ? out : null;
      } else {
        out = out.map((s) => s + c);
        i++;
      }
    }
    return inList ? null : out;
  };
  // The alternatives of one list, from after its `{` to after its `}`.
  const list = (): string[] | null => {
    const all: string[] = [];
    for (;;) {
      const part = sequence(true);
      if (part === null) return null;
      all.push(...part);
      if (all.length > MAX_PATTERN_ALTERNATIVES) return null;
      if (pattern[i++] === "}") return all;
    }
  };
  return sequence(false);
}

// The folder one alternative is rooted in, outside when it may reach out, or
// null for a relative one: it stays below its folder. `..` anywhere and a
// home pattern are outside whatever else they say. An absolute alternative is
// rooted at the last folder before its first wildcard: `/a/snap*/x` is rooted
// at `/a/`, since `snap*` also matches `snapshot-2`.
function alternativeRoot(alternative: string): string | null {
  const outside = "/";
  if (alternative.includes("..") || alternative.startsWith("~")) return outside;
  if (!(alternative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(alternative))) return null;
  const cut = alternative.search(/[*?[{]/);
  if (cut === -1) return alternative;
  const slash = Math.max(alternative.lastIndexOf("/", cut), alternative.lastIndexOf("\\", cut));
  return alternative.slice(0, slash + 1) || outside;
}

// The folders a file pattern is rooted in: one for each alternative of its
// brace lists that is absolute or may reach out, read both as written and
// with its escapes removed (`\/etc` is `/etc` to the glob engine). Empty when
// every alternative is relative. Outside when the pattern holds `..`, its
// braces do not balance, or it has too many alternatives, or lists nested too
// deep, to check.
function patternRoots(pattern: string): string[] {
  const outside = ["/"];
  if (pattern.includes("..")) return outside;
  let alts: string[] | null;
  try {
    alts = alternatives(pattern);
  } catch {
    // lists nested deeper than the stack can follow
    alts = null;
  }
  if (alts === null) return outside;
  const roots = new Set<string>();
  for (const alt of alts) {
    for (const form of [alt, alt.replace(/\\(.)/gs, "$1")]) {
      const root = alternativeRoot(form);
      if (root !== null) roots.add(root);
    }
  }
  return [...roots];
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
    const roots = patternRoots(fields[k] as string);
    // Named by the pattern itself in the trace, so the record says what was asked.
    if (roots.some((root) => !within(snapshot, place(snapshot, root) ?? "/"))) return { tool: call.tool, path: fields[k] as string, inside: false, range: null, ok: call.ok };
    raws.push(...roots);
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
