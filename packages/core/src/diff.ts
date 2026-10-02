// Parse a unified diff into a map of (file -> set of new-side line numbers).
// The change source hands this a zero-context diff (`-U0`), so the set holds
// exactly the lines the developer added or changed; the changed-line filter
// keeps only findings on those lines.
//
// Only the new side is tracked: deleted lines exist only on the old side and
// cannot carry a finding. Context lines (" ") are counted too, which matters
// only if a diff with context is passed in.
import type { DiffCoverage } from "./types.js";

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

// git C-quotes a header path that carries a byte outside printable ASCII, a
// double quote or a backslash (core.quotePath, on by default):
// `+++ "b/caf\303\251.ts"`. Read verbatim, that names a file called
// `"b/caf\303\251.ts"`, quotes included, which no tool can open. Decodes it
// back to the real path; an unquoted path passes through untouched.
export function unquoteDiffPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const chars = Array.from(raw.slice(1, -1));
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...encoder.encode(chars[i]));
      continue;
    }
    const next = chars[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      // Up to three octal digits: one byte of the UTF-8 encoding.
      let octal = "";
      while (octal.length < 3) {
        const digit = chars[i + 1];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += digit;
        i++;
      }
      bytes.push(parseInt(octal, 8));
      continue;
    }
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0));
    i++;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function parseDiffCoverage(diff: string): DiffCoverage {
  const out: DiffCoverage = new Map();
  let currentFile: string | null = null;
  let rightLine = 0;

  // Header lines are only read in a block's preamble, before its first @@.
  // Inside hunk payload an added source line "++ x" renders as "+++ x" (SQL
  // comments are the natural real-world case), which would otherwise be
  // parsed as a file header and point every later line of coverage at a path
  // built from source text. Once inHunk is set, "+++ x" falls through to the
  // payload branch below and is counted as the added line it actually is.
  let inHunk = false;

  for (const rawLine of diff.split("\n")) {
    // File header on the new side: "+++ b/<path>", or "+++ /dev/null" for a
    // deletion. currentFile is set only when there is a new-side file.
    if (!inHunk && rawLine.startsWith("+++ ")) {
      const target = unquoteDiffPath(rawLine.slice(4).trim());
      if (target === "/dev/null") {
        currentFile = null;
      } else if (target.startsWith("b/")) {
        currentFile = target.slice(2);
        if (!out.has(currentFile)) out.set(currentFile, new Set());
      } else {
        // Some diff producers omit the b/ prefix; accept as-is.
        currentFile = target;
        if (!out.has(currentFile)) out.set(currentFile, new Set());
      }
      continue;
    }
    if (!inHunk && rawLine.startsWith("--- ")) continue;
    if (rawLine.startsWith("diff --git ")) {
      // New file boundary. Wait for the +++ line to set currentFile.
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (rawLine.startsWith("@@")) {
      inHunk = true;
      // Hunk header: @@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@ <ctx>
      const m = /\+(\d+)(?:,\d+)?/.exec(rawLine);
      if (m) rightLine = parseInt(m[1], 10);
      continue;
    }
    if (!currentFile) continue;

    const c = rawLine[0];
    if (c === "+") {
      out.get(currentFile)!.add(rightLine);
      rightLine++;
    } else if (c === " ") {
      out.get(currentFile)!.add(rightLine);
      rightLine++;
    }
    // "-" is an old-side line and does not advance the new side. Other
    // markers (the "\ No newline at end of file" sentinel, blank lines
    // outside any hunk) are ignored without changing line state.
  }
  return out;
}
