// Turns the tool calls a driver reports into trace entries, deciding by
// script, never by the driver, whether each call stayed inside the snapshot.
// It fails closed: a call whose input cannot be read, a path that cannot be
// placed (a NUL, a `~user`), a path holding `$` or `%` that names no file in
// the snapshot, or any path-bearing field that leaves the snapshot marks the
// whole call as outside. The agent's own permission rules are the boundary;
// this check is the alarm that fails the run when the trace shows the
// boundary was not where it should be.
import { existsSync, lstatSync, realpathSync } from "node:fs";
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

// True when `path` is `root` or below it. A name that starts with two dots
// (`..env`) is below; only a `..` step climbs.
function within(root: string, path: string): boolean {
  const a = FOLD_CASE ? root.toLowerCase() : root;
  const b = FOLD_CASE ? path.toLowerCase() : path;
  const rel = relative(a, b);
  return rel === "" || (!isAbsolute(rel) && !rel.split(sep).includes(".."));
}

// The most alternatives a file pattern's brace lists may expand to before the
// check gives up and marks the call outside: `{a,b}` ten times over is 1024.
const MAX_PATTERN_ALTERNATIVES = 256;

// How our reading of a file pattern compares with the real one. Claude Code
// 2.1.289 (read in its binary) sends both tools through ripgrep: Grep's
// `glob` goes to `rg --glob` after Claude Code splits it at spaces, and at
// commas in a piece without both braces; Glob's pattern goes to `rg --files
// --glob`, searched from the folder before its first `*?[{` when it is
// absolute. ripgrep (14.1.1 checked on this Mac) only filters what it walks
// under that folder. Each place the two readings could differ, and why ours
// is the same or stricter:
// - Escapes: ripgrep reads `\x` as `x`. We check every reading both with its
//   escapes removed and as written, with `\` taken as a separator.
// - A brace inside a bracket class (`[{]`): a character to ripgrep, a list to
//   us, which leaves the braces unbalanced (outside) or adds alternatives we
//   also check, besides the whole pattern.
// - Nested lists: ripgrep 14.1.1 refuses them; we expand and check each.
// - A comma outside braces: plain text to ripgrep, a split point to Claude
//   Code's Grep; we check the whole and every piece.
// - A leading `!`: ripgrep's negation, which lists everything else under the
//   same folder; we check the pattern with and without it.
// - Windows separators: we root an alternative that starts with `\` as one
//   that starts with `/`, and `resolve` places it as the platform does: the
//   drive's root on Windows, a name in the snapshot on macOS and Linux.
// - The folder Claude Code searches from: we check the whole pattern, braces
//   unexpanded, as well as each alternative.

// Every alternative a file pattern's brace lists name, nested lists included:
// `{src,lib/{a,b}}/*.ts` is `src/*.ts`, `lib/a/*.ts` and `lib/b/*.ts`. A
// backslash escapes the next character and is kept in the alternative. Null
// when the braces do not balance or the alternatives would number more than
// MAX_PATTERN_ALTERNATIVES.
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

// True for a path segment that is `..`, or that is two units each able to
// match a dot (`.?`, `?.`, `??`, `.[.]`). A wildcard never climbs: ripgrep
// and node's glob match the names a folder listing yields, and a listing
// never holds `..`, so only a literal `..` step leaves a folder. The
// two-unit forms are outside anyway, the safe side, since a pattern rarely
// needs one. A segment with `*` is not: `*`, `.*` and `*.*` are everyday
// patterns. Every bracket class counts as able to match a dot (`[!a]` and
// `[--/]` do); `[...slug]` is one class, so one unit.
function parentStep(segment: string): boolean {
  let units = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]!;
    if (c === "*") return false;
    // A class: `]` right after `[` or `[!` is one of its members.
    const from = segment[i + 1] === "!" || segment[i + 1] === "^" ? i + 2 : i + 1;
    const close = c === "[" ? segment.indexOf("]", from + 1) : -1;
    if (close !== -1) i = close;
    else if (c !== "." && c !== "?") return false;
    if (++units > 2) return false;
  }
  return units === 2;
}

// The folder one reading of a pattern is rooted in, outside when it may
// reach out, or null for a relative one: it stays below its folder. A `..`
// step and a home pattern are outside whatever else they say. An absolute
// reading is rooted at the last folder before its first wildcard:
// `/a/snap*/x` is rooted at `/a/`, since `snap*` also matches `snapshot-2`.
function readingRoot(reading: string): string | null {
  const outside = "/";
  if (reading.split(/[\\/]/).some(parentStep) || reading.startsWith("~")) return outside;
  if (!(reading.startsWith("/") || reading.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(reading))) return null;
  const cut = reading.search(/[*?[{]/);
  if (cut === -1) return reading;
  const slash = Math.max(reading.lastIndexOf("/", cut), reading.lastIndexOf("\\", cut));
  return reading.slice(0, slash + 1) || outside;
}

// The texts a file pattern is matched as: the whole, and for Grep's `glob`
// each piece Claude Code hands ripgrep; each with and without a leading `!`.
function texts(value: string, grepGlob: boolean): string[] {
  const all = [value];
  if (grepGlob) for (const piece of value.split(/\s+/)) all.push(...(piece.includes("{") && piece.includes("}") ? [piece] : piece.split(",")));
  return [...new Set(all.flatMap((t) => (t.startsWith("!") ? [t, t.slice(1)] : [t])))];
}

// The folders a file pattern is rooted in: one for each reading that is
// absolute or may reach out. The readings of a text are the text itself and
// each alternative of its brace lists, each as written and with its escapes
// removed (`\/etc` is `/etc` to ripgrep). Empty when every reading is
// relative. Outside when braces do not balance, or there are too many
// alternatives, or lists nested too deep, to check.
function patternRoots(value: string, grepGlob: boolean): string[] {
  const outside = ["/"];
  const roots = new Set<string>();
  for (const text of texts(value, grepGlob)) {
    let alts: string[] | null;
    try {
      alts = alternatives(text);
    } catch {
      // lists nested deeper than the stack can follow
      alts = null;
    }
    if (alts === null) return outside;
    for (const reading of [text, ...alts]) {
      for (const form of [reading, reading.replace(/\\(.)/gs, "$1")]) {
        const root = readingRoot(form);
        if (root !== null) roots.add(root);
      }
    }
  }
  return [...roots];
}

// A raw path as written, joined to the snapshot, `~/` read as the home
// folder; null when it cannot be placed: a NUL, or `~user`.
function literal(snapshot: string, raw: string): string | null {
  if (raw.includes("\0")) return null;
  if (raw === "~" || raw.startsWith("~/")) return join(homedir(), raw.slice(1));
  return raw.startsWith("~") ? null : resolve(snapshot, raw);
}

// Each raw path placed: its real form, or null when it cannot be placed.
function place(snapshot: string, raw: string): string | null {
  const abs = literal(snapshot, raw);
  return abs === null ? null : realDeep(abs);
}

// A path holding `$` or `%` may be a variable the agent expanded (`$HOME`,
// `%USERPROFILE%`) or a real name (Remix's `posts.$slug.tsx`, `100%.md`).
// It is taken as the name only when that name exists.
function named(snapshot: string, raw: string): boolean {
  if (!raw.includes("$") && !raw.includes("%")) return true;
  const abs = literal(snapshot, raw);
  if (abs === null) return false;
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
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
  // Path fields and the path a read delivered; the folders patterns are rooted in.
  const paths: string[] = [];
  const roots: string[] = [];
  for (const k of PATH_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    paths.push(fields[k] as string);
  }
  for (const k of call.tool === "Grep" ? GREP_PATTERN_FIELDS : PATTERN_FIELDS) {
    if (fields[k] === undefined || fields[k] === null) continue;
    if (typeof fields[k] !== "string") return { tool: call.tool, path: `(a ${k} that is not text)`, inside: false, range: null, ok: true };
    const found = patternRoots(fields[k] as string, call.tool === "Grep");
    // Named by the pattern itself in the trace, so the record says what was asked.
    if (found.some((root) => !within(snapshot, place(snapshot, root) ?? "/"))) return { tool: call.tool, path: fields[k] as string, inside: false, range: null, ok: call.ok };
    roots.push(...found);
  }
  if (call.read) paths.push(call.read.path);
  if (call.tool === "Read" && typeof fields.file_path !== "string") {
    return { tool: call.tool, path: "(a read with no file_path)", inside: false, range: null, ok: true };
  }
  for (const raw of paths) {
    const real = place(snapshot, raw);
    if (real === null || !within(snapshot, real) || !named(snapshot, raw)) return { tool: call.tool, path: raw, inside: false, range, ok: call.ok };
  }
  const first = paths[0] ?? roots[0] ?? null;
  const real = first === null ? null : place(snapshot, call.read?.path ?? first);
  const rel = real === null ? null : relative(FOLD_CASE ? snapshot.toLowerCase() : snapshot, FOLD_CASE ? real.toLowerCase() : real) === "" ? "." : real.slice(snapshot.length + 1);
  return { tool: call.tool, path: rel, inside: true, range, ok: call.ok };
}
