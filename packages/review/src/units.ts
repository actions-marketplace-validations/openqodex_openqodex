import { changedHunks } from "@openqodex/core";
import type { Change, HunkRef, ReviewUnit } from "@openqodex/core";

export const GROUP_DIFF_BYTES = 30 * 1024;
export const MAX_UNIT_DIFF_BYTES = 120 * 1024;

export function hunkRefs(change: Change): HunkRef[] {
  const order = new Map(change.files.map((f, i) => [f.path, i]));
  return changedHunks(change)
    .sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0) || a.start - b.start || Number(a.deletion) - Number(b.deletion))
    .map((h, i) => ({ id: `h${i + 1}`, ...h }));
}

// Attribute diff rows to their changed range, including headers and removed
// rows. Ranges stay indivisible: a hunk belongs to exactly one unit.
function hunkBytes(text: string, hunks: HunkRef[]): number[] {
  const sizes = hunks.map(() => 0);
  let line = 1;
  for (const row of text.split(/(?<=\n)/)) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (header) line = Math.max(1, Number(header[1]));
    let i = hunks.findIndex((h) => h.end >= line);
    if (i < 0) i = hunks.length - 1;
    if (i >= 0) sizes[i] += Buffer.byteLength(row, "utf8");
    if (!header && (row.startsWith("+") && !row.startsWith("+++") || row.startsWith(" "))) line++;
  }
  return sizes;
}

export function unitsOf(change: Change, hunks: HunkRef[]): ReviewUnit[] {
  const out: ReviewUnit[] = [];
  let small: ReviewUnit | null = null;
  const add = (files: string[], refs: HunkRef[], bytes: number): ReviewUnit => {
    const unit = { id: `u${out.length + 1}`, files, hunks: refs, diffBytes: bytes };
    out.push(unit);
    return unit;
  };
  for (const file of change.files) {
    const text = (change.diffs ?? []).filter((d) => d.path === file.path).map((d) => d.text).join("");
    const bytes = Buffer.byteLength(text, "utf8");
    const refs = hunks.filter((h) => h.path === file.path);
    if (refs.length === 0) continue;
    if (bytes <= GROUP_DIFF_BYTES) {
      if (small === null || small.diffBytes + bytes > GROUP_DIFF_BYTES) small = add([], [], 0);
      small.files.push(file.path);
      small.hunks.push(...refs);
      small.diffBytes += bytes;
      continue;
    }
    small = null;
    if (bytes <= MAX_UNIT_DIFF_BYTES || refs.length < 2) {
      add([file.path], refs, bytes);
      continue;
    }
    const sizes = hunkBytes(text, refs);
    let unit: ReviewUnit | null = null;
    refs.forEach((h, i) => {
      if (unit === null || unit.diffBytes + sizes[i]! > MAX_UNIT_DIFF_BYTES) unit = add([file.path], [], 0);
      unit.hunks.push(h);
      unit.diffBytes += sizes[i]!;
    });
  }
  return out;
}
