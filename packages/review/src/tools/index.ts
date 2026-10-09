// The five tools the brain gives a model reviewer, as plain functions over
// the frozen snapshot of one review:
//   read_file           lines of a file, numbered as the snapshot holds them
//   search_code         a regular expression over the snapshot's text files
//   list_files          the snapshot's files, by glob
//   read_diff_for_file  one changed file's diff against the base
//   find_callers        the callers of a symbol, from the code graph
// Every call is checked before it runs: a path or a glob is placed with the
// agents' own `classify` (outside the snapshot is refused and marked
// outside), a link is never followed, the snapshot's `.git` entry is never
// read. Every reply is bounded to 32 KB, cut only at a whole line and saying
// so. No tool starts a program.
//
// Secrets: a tool reads content only through the redacted views below
// (`redactedLines`, `redactedDiff`), on top of the snapshot the brain already
// redacted (redactSnapshot), so no raw secret is ever served, searched or
// counted. search_code skips every line that holds a redaction, so a pattern
// aimed at a secret (its prefix, the redaction marker) gets the answer a miss
// gets. Each reply is redacted once more at the end, and the log keeps each
// call's arguments redacted the same way.
import { lstatSync, openSync, closeSync, fstatSync, readFileSync, constants } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import { REDACTED, matchesGlob, redactSecrets, redactSecretsKeepingLines, secretTexts } from "@openqodex/core";
import type { Change } from "@openqodex/core";
import { API_VERSION, query } from "@openqodex/graph";
import type { Candidate, Graph, Item } from "@openqodex/graph";
import { classify } from "../agents/trace.js";
import type { ToolDefinition } from "../reviewer.js";
import { MAX_FILE_BYTES, snapshotFiles } from "../snapshot.js";
import { compilePattern, matchesLine } from "./pattern.js";

// The most bytes one tool reply carries.
export const TOOL_REPLY_BYTES = 32 * 1024;
const BOUND = `${TOOL_REPLY_BYTES / 1024} KB`;
// How much of a call's arguments the log keeps.
const MAX_DETAIL_CHARS = 2000;
const MAX_PATTERN_CHARS = 1000;
const MAX_MATCHES = 500;
const MAX_MATCH_CHARS = 300;
// The most matcher steps one search may take (characters searched times the
// matcher's size); a search that would pass it stops there and says so.
const SEARCH_WORK = 200_000_000;
const MAX_CALLERS = 100;

export const TOOL_NAMES = ["read_file", "search_code", "list_files", "read_diff_for_file", "find_callers"] as const;

const GLOB = "Optional. Only files whose path matches this glob: * matches within one folder, ** across folders, ? one character.";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "read_file",
    description: `Read lines of a file in the code under review, numbered as the file holds them. Without start and lines it reads from line 1 as far as one reply allows (${BOUND}). The first line of the reply says which lines it carries; ask again from the next line for more.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path, relative to the root of the code under review." },
        start: { type: "integer", minimum: 1, description: "Optional. The first line to read; 1 when left out." },
        lines: { type: "integer", minimum: 1, description: "Optional. How many lines to read." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: `Search the text files of the code under review, line by line, for a regular expression in JavaScript syntax, case sensitive. Backreferences and lookarounds are not supported. A line that holds a redacted secret is never a result. Each match comes back as path:line: text, up to ${BOUND}.`,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression, in JavaScript syntax, tested on each line." },
        glob: { type: "string", description: GLOB },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "list_files",
    description: `List the files of the code under review, one path per line, up to ${BOUND}.`,
    parameters: {
      type: "object",
      properties: { glob: { type: "string", description: GLOB } },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "read_diff_for_file",
    description: `Read the diff of one changed file against the base, as git shows it with three lines of context, up to ${BOUND}.`,
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "The changed file's path, relative to the root of the code under review." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "find_callers",
    description: "Find the code that calls a function, method or class, from the code graph built for this review. Give the symbol's name and the file that defines it. The reply says how sure each call site is and what the graph could not see.",
    parameters: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "The symbol's name, or Owner.name for a method." },
        file: { type: "string", description: "The path of the file that defines the symbol, relative to the root of the code under review." },
      },
      required: ["symbol", "file"],
      additionalProperties: false,
    },
  },
];

// What the tools read: the snapshot folder, the change (for the diffs), the
// run's secrets (raw, in memory only) and the code graph, when one was
// built (`graphNote` says why there is none).
export type ToolBox = { snapshotDir: string; change: Change; secrets: string[]; graph: Graph | null; graphNote: string | null };

// One call, run or refused. `text` is the reply that goes into the
// transcript; the other fields are the brain's log of it (ToolLogEntry
// without the delivery fields).
export type ToolOutcome = {
  tool: string;
  text: string;
  ok: boolean;
  path: string | null;
  inside: boolean | null;
  range: [number, number] | null;
  reason: string | null;
  detail: string;
};

type Args = Record<string, unknown>;
type Placed = { rel: string } | { refused: Omit<ToolOutcome, "tool" | "detail"> };

const refusal = (reason: string, inside: boolean | null, path: string | null): Omit<ToolOutcome, "tool" | "detail"> => ({ text: `refused: ${reason}`, ok: false, path, inside, range: null, reason });
const badArgs = (why: string) => refusal(`bad arguments: ${why}`, true, null);

// The arguments as an object: the object itself, or a JSON text holding one.
function argsOf(raw: unknown): Args | null {
  let v = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Args) : null;
}

function str(args: Args, key: string, required: boolean): string | null | { bad: string } {
  const v = args[key];
  if (v === undefined || v === null) return required ? { bad: `${key} is required` } : null;
  if (typeof v !== "string" || v === "") return { bad: `${key} must be non-empty text` };
  return v;
}

function int(args: Args, key: string): number | null | { bad: string } {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return { bad: `${key} must be a whole number of 1 or more` };
  return v;
}

const isBad = (v: unknown): v is { bad: string } => v !== null && typeof v === "object" && "bad" in v;

// A path or a glob placed in the snapshot. The agents' `classify` decides
// whether it stays inside (it follows links and fails closed); an attempt
// outside is refused and marked outside. Inside, the path must be relative,
// must not name the `.git` entry and, when `walk` is set, must reach a
// regular file through no link, each step checked without following one.
function placePath(box: ToolBox, tool: string, raw: string, field: "path" | "glob", walk: boolean): Placed {
  const entry = classify(box.snapshotDir, { tool, input: { [field]: raw }, ok: true, read: null });
  if (entry.inside !== true) return { refused: refusal("the path is outside the code under review", false, raw) };
  if (isAbsolute(raw) || raw.startsWith("\\")) return { refused: refusal("give the path relative to the root of the code under review", true, null) };
  const rel = posix.normalize(raw.replaceAll("\\", "/")).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (rel === "" || rel === ".") return field === "glob" ? { rel: "**" } : { refused: refusal("name a file, not the root folder", true, ".") };
  const parts = rel.split("/");
  if (parts[0]!.toLowerCase() === ".git") return { refused: refusal("the .git entry is not part of the code under review", true, rel) };
  if (!walk) return { rel };
  let at = box.snapshotDir;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return { refused: refusal(`no such file: ${rel}`, true, rel) };
    }
    if (st.isSymbolicLink()) return { refused: refusal(`${parts.slice(0, i + 1).join("/")} is a link, and links are not followed`, true, rel) };
    if (i < parts.length - 1 && !st.isDirectory()) return { refused: refusal(`no such file: ${rel}`, true, rel) };
    if (i === parts.length - 1 && !st.isFile()) return { refused: refusal(`${rel} is not a file`, true, rel) };
  }
  return { rel };
}

// A snapshot file's text, read without following a link: null when it is
// over the size bound, holds a NUL byte or is not UTF-8.
function fileText(full: string): string | null {
  let fd = -1;
  try {
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const buf = readFileSync(fd);
    const text = buf.toString("utf8");
    return buf.includes(0) || !Buffer.from(text, "utf8").equals(buf) ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== -1) closeSync(fd);
  }
}

// The only way a tool reads a file: its lines with every secret the
// scanners found redacted, line breaks kept so each line keeps its number
// (the redaction the snapshot itself went through). Null when the file is
// not text a tool may read.
function redactedLines(box: ToolBox, rel: string): string[] | null {
  const content = fileText(join(box.snapshotDir, rel));
  if (content === null) return null;
  if (content === "") return [];
  const lines = redactSecretsKeepingLines(content, box.secrets).split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

// The only way a tool reads a diff: the change's diff of one file with every
// secret the scanners found redacted, as the brief's diff is. Null when the
// change holds no diff for it.
function redactedDiff(box: ToolBox, rel: string): string | null {
  const diff = box.change.diffs?.find((d) => d.path === rel);
  return diff === undefined ? null : redactSecrets(diff.text, box.secrets);
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Rows after a header, as many whole rows as fit in the bound.
function fill(header: string, rows: string[]): { text: string; shown: number } {
  let size = bytes(header);
  let shown = 0;
  for (const row of rows) {
    const add = bytes(row) + 1;
    if (size + add > TOOL_REPLY_BYTES) break;
    size += add;
    shown++;
  }
  return { text: [header, ...rows.slice(0, shown)].join("\n"), shown };
}

function readFile(box: ToolBox, args: Args): Omit<ToolOutcome, "tool" | "detail"> {
  const raw = str(args, "path", true);
  const start = int(args, "start");
  const count = int(args, "lines");
  for (const v of [raw, start, count]) if (isBad(v)) return badArgs(v.bad);
  const placed = placePath(box, "read_file", raw as string, "path", true);
  if ("refused" in placed) return placed.refused;
  const { rel } = placed;
  const all = redactedLines(box, rel);
  if (all === null) return refusal(`${rel} is not a text file of ${MAX_FILE_BYTES / 1024 / 1024} MB or less`, true, rel);
  const total = all.length;
  const first = (start as number | null) ?? 1;
  if (total === 0) return { text: `${rel} is empty`, ok: true, path: rel, inside: true, range: null, reason: null };
  if (first > total) return refusal(`${rel} has ${total} lines`, true, rel);
  const end = count === null ? total : Math.min(total, first + (count as number) - 1);
  const rows: string[] = [];
  for (let n = first; n <= end; n++) rows.push(`${n}\t${all[n - 1]}`);
  // The header is measured at its longest, so the lines that fit under it
  // still fit once it names the last of them.
  const head = (last: number, cut: boolean) => `${rel} lines ${first} to ${last} of ${total}${cut ? ` (cut at ${BOUND}; ask for line ${last + 1} onward)` : ""}`;
  const { shown } = fill(head(end, true), rows);
  if (shown === 0) return refusal(`line ${first} is longer than the ${BOUND} a reply may carry`, true, rel);
  const last = first + shown - 1;
  const cut = last < end;
  return {
    text: [head(last, cut), ...rows.slice(0, shown)].join("\n"),
    ok: true,
    path: rel,
    inside: true,
    range: [first, last],
    reason: cut ? `cut at ${BOUND}: lines ${first} to ${last} of ${total} sent; ask for line ${last + 1} onward` : null,
  };
}

// The snapshot's files a glob admits, or the refusal of the glob.
function filesFor(box: ToolBox, tool: string, glob: string | null): { files: string[] } | { refused: Omit<ToolOutcome, "tool" | "detail"> } {
  const all = snapshotFiles(box.snapshotDir);
  if (glob === null) return { files: all };
  const placed = placePath(box, tool, glob, "glob", false);
  if ("refused" in placed) return placed;
  return { files: all.filter((f) => matchesGlob(f, placed.rel)) };
}

async function searchCode(box: ToolBox, args: Args): Promise<Omit<ToolOutcome, "tool" | "detail">> {
  const pattern = str(args, "pattern", true);
  const glob = str(args, "glob", false);
  for (const v of [pattern, glob]) if (isBad(v)) return badArgs(v.bad);
  if ((pattern as string).length > MAX_PATTERN_CHARS) return badArgs(`pattern is over ${MAX_PATTERN_CHARS} characters`);
  const listed = filesFor(box, "search_code", glob as string | null);
  if ("refused" in listed) return listed.refused;
  const compiled = compilePattern(pattern as string);
  if ("refused" in compiled) return refusal(compiled.refused, true, ".");
  const { program } = compiled;
  const found: string[] = [];
  let limited = false;
  let work = 0;
  let searched = 0;
  outer: for (const [k, rel] of listed.files.entries()) {
    // A long search lets the rest of the process run between files.
    if (k > 0 && k % 100 === 0) await new Promise<void>((done) => setImmediate(done));
    const lines = redactedLines(box, rel);
    if (lines === null) {
      searched++;
      continue;
    }
    // The work counts every line, a skipped one too, so where a search
    // stops never depends on where a secret was.
    const cost = lines.reduce((n, l) => n + (l.length + 1) * program.length, 0);
    if (work + cost > SEARCH_WORK) break;
    work += cost;
    searched++;
    for (const [i, line] of lines.entries()) {
      if (line.includes(REDACTED) || !matchesLine(program, line)) continue;
      found.push(`${rel}:${i + 1}: ${line.slice(0, MAX_MATCH_CHARS)}`);
      if (found.length >= MAX_MATCHES) {
        limited = true;
        break outer;
      }
    }
  }
  const stopped = !limited && searched < listed.files.length;
  const header = `${found.length}${limited ? " or more" : ""} ${found.length === 1 ? "match" : "matches"} in ${listed.files.length} ${listed.files.length === 1 ? "file" : "files"}${stopped ? `; the search stopped at its work bound after ${searched} of them` : ""}`;
  const { text, shown } = fill(header, found);
  const reason =
    shown < found.length
      ? `cut at ${BOUND}: ${shown} of ${found.length} matches sent; narrow the pattern or the glob`
      : limited
        ? `stopped at ${MAX_MATCHES} matches`
        : stopped
          ? `stopped at the search's work bound after ${searched} of ${listed.files.length} files; narrow the pattern or the glob`
          : null;
  return { text, ok: true, path: ".", inside: true, range: null, reason };
}

function listFiles(box: ToolBox, args: Args): Omit<ToolOutcome, "tool" | "detail"> {
  const glob = str(args, "glob", false);
  if (isBad(glob)) return badArgs(glob.bad);
  const listed = filesFor(box, "list_files", glob);
  if ("refused" in listed) return listed.refused;
  const rows = listed.files.map((f) => redactSecrets(f, box.secrets));
  const { text, shown } = fill(`${rows.length} ${rows.length === 1 ? "file" : "files"}${glob !== null ? ` match ${glob}` : ""}`, rows);
  return { text, ok: true, path: ".", inside: true, range: null, reason: shown < rows.length ? `cut at ${BOUND}: ${shown} of ${rows.length} files listed; narrow the glob` : null };
}

function readDiff(box: ToolBox, args: Args): Omit<ToolOutcome, "tool" | "detail"> {
  const raw = str(args, "path", true);
  if (isBad(raw)) return badArgs(raw.bad);
  // A deleted file's diff is part of the change, so the path need not exist.
  const placed = placePath(box, "read_diff_for_file", raw as string, "path", false);
  if ("refused" in placed) return placed.refused;
  const { rel } = placed;
  const diff = redactedDiff(box, rel);
  if (diff === null) {
    const changed = box.change.files.some((f) => f.path === rel);
    return refusal(changed ? `the diff of ${rel} is not available: the change is too large for every file's diff` : `${rel} is not a changed file; the brief lists the changed files`, true, rel);
  }
  const rows = diff.replace(/\n$/, "").split("\n");
  const head = (shown: number) => `${rel}: the diff against the base, ${shown === rows.length ? `${rows.length} lines` : `the first ${shown} of ${rows.length} lines`}`;
  const { shown } = fill(head(0), rows);
  return {
    text: [head(shown), ...rows.slice(0, shown)].join("\n"),
    ok: true,
    path: rel,
    inside: true,
    range: null,
    reason: shown < rows.length ? `cut at ${BOUND}: ${shown} of ${rows.length} diff lines sent` : null,
  };
}

function findCallers(box: ToolBox, args: Args): Omit<ToolOutcome, "tool" | "detail"> {
  const symbol = str(args, "symbol", true);
  const file = str(args, "file", true);
  for (const v of [symbol, file]) if (isBad(v)) return badArgs(v.bad);
  const placed = placePath(box, "find_callers", file as string, "path", false);
  if ("refused" in placed) return placed.refused;
  const { rel } = placed;
  if (box.graph === null) return refusal(`no code graph for this review${box.graphNote ? `: ${box.graphNote}` : ""}`, true, rel);
  const g = box.graph;
  const answer = query(
    { graph: g, generation: g.status.generation, treeSha: null, builtAt: null, laterEditsKnown: false },
    { apiVersion: API_VERSION, kind: "callers", target: { name: symbol as string, file: rel }, depth: 1, limit: MAX_CALLERS },
  );
  if (answer.error !== null) {
    const options = Array.isArray(answer.target) ? answer.target.map((c: Candidate) => ` ${c.name} (${c.kind}) at ${c.file}:${c.line}`).join(";") : "";
    return refusal(answer.error.code === "not-found" ? `the code graph has no symbol ${symbol} in ${rel}` : `${answer.error.message}${options ? `:${options}` : ""}`, true, rel);
  }
  const target = answer.target as Candidate;
  const items = answer.items as Item[];
  const c = answer.counts;
  const rows = items.map((i) => `- ${i.site.file}:${i.site.line} in ${i.fromName ?? i.from} (${i.site.tier}, ${i.kind})`);
  const notes = [
    `Counts: certain ${c.certain ?? "unknown"}, likely ${c.likely ?? "unknown"}, possible ${c.possible ?? "unknown"}.`,
    ...(answer.unknown.reasons.length > 0 ? [`The graph may miss callers: ${answer.unknown.reasons.join("; ")}.`] : []),
    ...(answer.truncated.omitted ? [`${answer.truncated.omitted} more call sites are not listed.`] : []),
  ];
  const header = `Callers of ${target.name} (${target.kind}) defined at ${target.file}:${target.line}, from the code graph:`;
  const body = rows.length > 0 ? rows : ["- none found"];
  const { text, shown } = fill([header, ...notes].join("\n"), body.map((r) => redactSecrets(r, box.secrets)));
  return { text, ok: true, path: rel, inside: true, range: null, reason: shown < body.length ? `cut at ${BOUND}: ${shown} of ${body.length} call sites sent` : null };
}

// Runs one tool call and returns the reply and its log fields. Never throws
// for anything the reviewer sent: a call it cannot run is refused with the
// reason. The last step redacts the reply once more; a reply that would
// still hold a secret is replaced by a refusal.
export async function runTool(box: ToolBox, name: string, raw: unknown): Promise<ToolOutcome> {
  const tool = typeof name === "string" ? name.slice(0, 100) : "(no name)";
  // The arguments as the log keeps them: redacted like every reply, then cut.
  let detail = "";
  try {
    detail = redactSecrets(typeof raw === "string" ? raw : (JSON.stringify(raw ?? null) ?? ""), box.secrets).slice(0, MAX_DETAIL_CHARS);
  } catch {
    detail = "(arguments that could not be written as JSON)";
  }
  let out: Omit<ToolOutcome, "tool" | "detail">;
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
    out = refusal(`${tool} is not a tool the brain defined; the tools are ${TOOL_NAMES.join(", ")}`, null, null);
  } else {
    const args = argsOf(raw);
    if (args === null) out = badArgs("the arguments are not a JSON object");
    else if (tool === "read_file") out = readFile(box, args);
    else if (tool === "search_code") out = await searchCode(box, args);
    else if (tool === "list_files") out = listFiles(box, args);
    else if (tool === "read_diff_for_file") out = readDiff(box, args);
    else out = findCallers(box, args);
  }
  const text = redactSecrets(out.text, box.secrets);
  // A path as the reviewer asked for it (an attempt outside) is redacted too.
  const path = out.path === null ? null : redactSecrets(out.path, box.secrets);
  const reason = out.reason === null ? null : redactSecrets(out.reason, box.secrets);
  if (secretTexts(box.secrets).some((s) => text.includes(s))) {
    return { tool, ...refusal("a secret the scanners found is in the reply", out.inside, path), detail };
  }
  return { tool, ...out, text, path, reason, detail };
}
