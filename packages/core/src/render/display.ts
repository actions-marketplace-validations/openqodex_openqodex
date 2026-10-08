// The display model report.html is drawn from: each changed file of the
// review with its hunks as rows, old and new line numbers kept apart. It is
// built while the diff and the matched secrets are still in memory, so every
// row is redacted before anything is written. Bounded: past DISPLAY_MAX_ROWS
// rows, whole files are left out with a note, never part of a hunk.
//
// The normal review renders it at once and keeps it only inside report.html.
// The two-step review (`review --agent`, then `--finalize`) saves it as
// display.json beside the brief, and finalize uses it only for the change it
// was made for (checkDisplay).
import { REDACTED, redactSecrets, redactSecretsKeepingLines } from "../redact.js";
import type { Change, ChangedFile } from "../types.js";

export const DISPLAY_VERSION = 1;
// Rows of source the page shows at most, over every file.
export const DISPLAY_MAX_ROWS = 50_000;
// Characters of one row; a longer row is cut and marked.
export const DISPLAY_MAX_ROW_CHARS = 5_000;
// Bytes of display.json at most; past it, files are left out from the largest.
export const DISPLAY_MAX_BYTES = 8 * 1024 * 1024;
// Lines shown above and below a finding in a whole-repository review.
const EXCERPT_CONTEXT = 3;

// Shorter matches are too likely to hit ordinary text (as in redact.ts).
const MIN_SECRET_LENGTH = 6;

export type DisplayRow = {
  kind: "context" | "add" | "del";
  old: number | null;
  new: number | null;
  text: string;
  // The file has no newline after this line.
  noNewline?: true;
  // The line was longer than DISPLAY_MAX_ROW_CHARS and is cut.
  cut?: true;
};

export type DisplayHunk = {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  // The text git prints after the second @@, such as the enclosing function.
  section: string;
  rows: DisplayRow[];
};

export type DisplayFile = {
  path: string;
  old_path: string | null;
  status: ChangedFile["status"];
  binary: boolean;
  // From the rows; null when no rows were read.
  additions: number | null;
  deletions: number | null;
  hunks: DisplayHunk[];
  // Why no rows are shown, in one plain line; null when they are.
  note: string | null;
};

export type Display = {
  version: typeof DISPLAY_VERSION;
  change_id: string;
  // "change": a diff; "excerpts": lines around each finding of a review of
  // the whole repository, which has no diff.
  kind: "change" | "excerpts";
  files: DisplayFile[];
  rows: number;
};

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// The hunks of one file's unified diff. Rows are counted from the hunk
// header, so a source line that looks like a header (a removed "-- x" shows
// as "--- x") is read as the row it is. Lines before the first hunk are the
// file's headers. A line that fits no row ends the parse.
export function parseHunks(text: string): DisplayHunk[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: DisplayHunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = HUNK.exec(lines[i] as string);
    i++;
    if (m === null) continue;
    const hunk: DisplayHunk = {
      old_start: Number(m[1]),
      old_lines: m[2] === undefined ? 1 : Number(m[2]),
      new_start: Number(m[3]),
      new_lines: m[4] === undefined ? 1 : Number(m[4]),
      section: m[5] ?? "",
      rows: [],
    };
    let oldLeft = hunk.old_lines;
    let newLeft = hunk.new_lines;
    let oldAt = hunk.old_start;
    let newAt = hunk.new_start;
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] as string).startsWith("\\"))) {
      const line = lines[i] as string;
      const mark = line[0];
      if (mark === "\\") {
        const last = hunk.rows.at(-1);
        if (last) last.noNewline = true;
      } else if ((mark === " " || line === "") && oldLeft > 0 && newLeft > 0) {
        hunk.rows.push({ kind: "context", old: oldAt++, new: newAt++, text: line.slice(1) });
        oldLeft--;
        newLeft--;
      } else if (mark === "-" && oldLeft > 0) {
        hunk.rows.push({ kind: "del", old: oldAt++, new: null, text: line.slice(1) });
        oldLeft--;
      } else if (mark === "+" && newLeft > 0) {
        hunk.rows.push({ kind: "add", old: null, new: newAt++, text: line.slice(1) });
        newLeft--;
      } else {
        break;
      }
      i++;
    }
    hunks.push(hunk);
  }
  return hunks;
}

function usableSecrets(secrets: string[]): string[] {
  return [...new Set(secrets)].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

// The pieces of a multi-line secret, one per line, long enough to be told
// from ordinary text: a hunk can hold only some lines of a private key, and
// each line of it is still redacted.
function secretPieces(secrets: string[]): string[] {
  const pieces = secrets.filter((s) => s.includes("\n")).flatMap((s) => s.split("\n").map((l) => l.replace(/\r$/, "").trim()));
  return [...new Set(pieces)].filter((p) => p.length >= MIN_SECRET_LENGTH);
}

function redactPieces(text: string, pieces: string[]): string {
  let out = text;
  for (const p of pieces) if (out.includes(p)) out = out.split(p).join(REDACTED);
  return out;
}

// Redacts one hunk's rows. Each side (old: context and removed rows; new:
// context and added rows) is joined back into the text it was in the file,
// so a secret over several lines is found whole, and redacted line by line
// so every row keeps its number. Then any line of a multi-line secret left
// in a row (one that only partly falls inside the hunk) is redacted, and a
// row that still holds a secret is replaced whole.
function redactHunk(hunk: DisplayHunk, secrets: string[], pieces: string[]): DisplayHunk {
  const side = (keep: (r: DisplayRow) => boolean): Map<DisplayRow, string> => {
    const rows = hunk.rows.filter(keep);
    const red = redactSecretsKeepingLines(rows.map((r) => r.text).join("\n"), secrets).split("\n");
    return new Map(rows.map((r, k) => [r, red[k] ?? REDACTED]));
  };
  const olds = side((r) => r.old !== null);
  const news = side((r) => r.new !== null);
  const rows = hunk.rows.map((r) => {
    const fromNew = news.get(r);
    const fromOld = olds.get(r);
    let text = fromNew !== undefined && fromNew !== r.text ? fromNew : (fromOld ?? fromNew ?? r.text);
    text = redactPieces(text, pieces);
    if (secrets.some((s) => text.includes(s))) text = REDACTED;
    return { ...r, text };
  });
  return { ...hunk, section: redactPieces(redactSecrets(hunk.section, secrets), pieces), rows };
}

function cutRow(row: DisplayRow): DisplayRow {
  return row.text.length > DISPLAY_MAX_ROW_CHARS ? { ...row, text: row.text.slice(0, DISPLAY_MAX_ROW_CHARS), cut: true } : row;
}

const LIMIT_NOTE = `Not shown: the page holds at most ${DISPLAY_MAX_ROWS.toLocaleString("en-US")} lines of code, and this file is past that display limit.`;

function noteFor(f: ChangedFile, hasDiff: boolean, tooLarge: boolean): string | null {
  if (f.binary) return "Binary file: there is no text to show.";
  if (tooLarge) return "Not shown: the change to this file is over the size the review takes.";
  if (!hasDiff) return "No lines to show.";
  if (f.status === "renamed") return "Renamed, with no line changed.";
  if (f.status === "deleted") return "Deleted, with no line to show.";
  return "No line changed: only the file's mode or type changed.";
}

// The display of a change, from its per-file diffs, every row redacted.
export function buildDisplay(args: { change: Change; secrets: string[] }): Display {
  const { change } = args;
  const secrets = usableSecrets(args.secrets);
  const pieces = secretPieces(secrets);
  const red = (s: string) => redactPieces(redactSecrets(s, secrets), pieces);
  const diffs = new Map((change.diffs ?? []).map((d) => [d.path, d.text]));
  const tooLarge = new Set(change.notReviewed);
  let rows = 0;
  const files = change.files.map((f): DisplayFile => {
    const text = diffs.get(f.path);
    const hunks = f.binary || text === undefined ? [] : parseHunks(text).map((h) => redactHunk(h, secrets, pieces));
    const count = hunks.reduce((n, h) => n + h.rows.length, 0);
    const base = { path: red(f.path), old_path: f.oldPath === null ? null : red(f.oldPath), status: f.status, binary: f.binary };
    if (hunks.length === 0) return { ...base, additions: null, deletions: null, hunks: [], note: noteFor(f, text !== undefined, tooLarge.has(f.path)) };
    const all = hunks.flatMap((h) => h.rows);
    const sums = { additions: all.filter((r) => r.kind === "add").length, deletions: all.filter((r) => r.kind === "del").length };
    if (rows + count > DISPLAY_MAX_ROWS) return { ...base, ...sums, hunks: [], note: LIMIT_NOTE };
    rows += count;
    return { ...base, ...sums, hunks: hunks.map((h) => ({ ...h, rows: h.rows.map(cutRow) })), note: null };
  });
  return { version: DISPLAY_VERSION, change_id: change.id, kind: "change", files, rows };
}

// The display of a review of the whole repository: a few lines around each
// cited line, read through `read` (the redacted snapshot), redacted again.
export function buildExcerptDisplay(args: {
  changeId: string;
  cited: { file_path: string; line_number: number; line_end: number }[];
  read: (path: string) => string | null;
  secrets: string[];
}): Display {
  const secrets = usableSecrets(args.secrets);
  const pieces = secretPieces(secrets);
  const byFile = new Map<string, [number, number][]>();
  for (const c of args.cited) {
    const spans = byFile.get(c.file_path) ?? [];
    spans.push([Math.max(1, c.line_number - EXCERPT_CONTEXT), Math.max(c.line_number, c.line_end) + EXCERPT_CONTEXT]);
    byFile.set(c.file_path, spans);
  }
  let rows = 0;
  const files: DisplayFile[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const base = { path: redactPieces(redactSecrets(path, secrets), pieces), old_path: null, status: "modified" as const, binary: false, additions: null, deletions: null };
    const raw = args.read(path);
    if (raw === null) {
      files.push({ ...base, hunks: [], note: "The file could not be read for this page." });
      continue;
    }
    const lines = redactSecretsKeepingLines(raw, secrets).split("\n");
    if (lines.at(-1) === "") lines.pop();
    // Overlapping or touching spans become one.
    const spans = (byFile.get(path) ?? []).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of spans) {
      const last = merged.at(-1);
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    const hunks: DisplayHunk[] = merged
      .map(([s, e]): DisplayHunk => {
        const end = Math.min(e, lines.length);
        const shown: DisplayRow[] = [];
        for (let n = s; n <= end; n++) shown.push(cutRow({ kind: "context", old: null, new: n, text: redactPieces(lines[n - 1] ?? "", pieces) }));
        return { old_start: 0, old_lines: 0, new_start: s, new_lines: shown.length, section: "", rows: shown };
      })
      .filter((h) => h.rows.length > 0);
    const count = hunks.reduce((n, h) => n + h.rows.length, 0);
    if (rows + count > DISPLAY_MAX_ROWS) {
      files.push({ ...base, hunks: [], note: LIMIT_NOTE });
      continue;
    }
    rows += count;
    files.push({ ...base, hunks, note: hunks.length === 0 ? "The cited lines are past the end of the file." : null });
  }
  return { version: DISPLAY_VERSION, change_id: args.changeId, kind: "excerpts", files, rows };
}

// display.json for the two-step review, within DISPLAY_MAX_BYTES: past it,
// the files with the most rows lose their rows, with a note, until it fits.
export function displayJson(display: Display): string {
  let d = display;
  let text = `${JSON.stringify(d)}\n`;
  while (Buffer.byteLength(text, "utf8") > DISPLAY_MAX_BYTES) {
    const largest = d.files.reduce((best, f, i) => (f.hunks.length > 0 && (best === -1 || rowsOf(f) > rowsOf(d.files[best] as DisplayFile)) ? i : best), -1);
    if (largest === -1) break;
    const dropped = rowsOf(d.files[largest] as DisplayFile);
    d = { ...d, rows: d.rows - dropped, files: d.files.map((f, i) => (i === largest ? { ...f, hunks: [], note: LIMIT_NOTE } : f)) };
    text = `${JSON.stringify(d)}\n`;
  }
  return text;
}

function rowsOf(f: DisplayFile): number {
  return f.hunks.reduce((n, h) => n + h.rows.length, 0);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isNumOrNull = (v: unknown) => v === null || isNum(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// A saved display, parsed, when it is in the saved shape and was made for
// `changeId`; else null, and the page shows no code.
export function checkDisplay(value: unknown, changeId: string): Display | null {
  if (value === null || typeof value !== "object") return null;
  const d = value as Partial<Display>;
  if (d.version !== DISPLAY_VERSION || d.change_id !== changeId || (d.kind !== "change" && d.kind !== "excerpts") || !Array.isArray(d.files) || !isNum(d.rows)) return null;
  let rows = 0;
  for (const f of d.files as unknown[]) {
    if (f === null || typeof f !== "object") return null;
    const file = f as Partial<DisplayFile>;
    if (!isStr(file.path) || !(file.old_path === null || isStr(file.old_path)) || !["added", "modified", "deleted", "renamed"].includes(file.status as string)) return null;
    if (typeof file.binary !== "boolean" || !isNumOrNull(file.additions) || !isNumOrNull(file.deletions) || !(file.note === null || isStr(file.note)) || !Array.isArray(file.hunks)) return null;
    for (const h of file.hunks as unknown[]) {
      if (h === null || typeof h !== "object") return null;
      const hunk = h as Partial<DisplayHunk>;
      if (!isNum(hunk.old_start) || !isNum(hunk.old_lines) || !isNum(hunk.new_start) || !isNum(hunk.new_lines) || !isStr(hunk.section) || !Array.isArray(hunk.rows)) return null;
      for (const r of hunk.rows as unknown[]) {
        if (r === null || typeof r !== "object") return null;
        const row = r as Partial<DisplayRow>;
        if (!["context", "add", "del"].includes(row.kind as string) || !isNumOrNull(row.old) || !isNumOrNull(row.new) || !isStr(row.text)) return null;
        rows++;
      }
    }
  }
  return rows <= DISPLAY_MAX_ROWS ? (d as Display) : null;
}
