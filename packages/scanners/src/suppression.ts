// The inline suppression comments each built-in scanner obeys, and where it
// obeys them. A change that adds one makes that scanner report nothing on
// the line, so the runner raises the comment itself as a candidate.
//
// Each entry follows the scanner's documentation and its source at the
// pinned version, and was run through the scanner itself for all but rubocop
// and golangci-lint, which need Ruby and Go. Where the two disagree, the
// entry follows what the scanner does. docs/scanners.md lists the sources.
// actionlint, brakeman, osv-scanner and sqllint have no inline marker:
// actionlint and brakeman read only their settings or ignore files, osv-scanner
// its osv-scanner.toml, and sqllint has none.

import type { BuiltinScanner } from "@openqodex/core";
import { comments } from "./comments.js";
import type { Comment, Family } from "./comments.js";

type Marker = {
  // The marker as the scanner writes it. `{kw}` is replaced by the match's
  // `kw` group, which only ever holds one of a fixed set of words, so the name
  // never carries text from the line.
  name: string;
  // Tested on each comment's text from its opener, or on each line for the
  // "line" family. Group `at` is where the marker starts, for its line.
  pattern: RegExp;
  // Only a comment with nothing but blanks before it on its line.
  ownLine?: true;
};

// "line": the scanner obeys the marker anywhere on the line, in a comment,
// a string or code alike.
type Entry = { family: Family | "line"; markers: Marker[] };

export const SUPPRESSION_MARKERS: Partial<Record<BuiltinScanner, Entry>> = {
  // A space, then nosem or nosemgrep in any case, anywhere on the line or on
  // the line before a match. Its documentation asks for a comment; semgrep
  // 1.94.0 obeys the text inside a string too, and never without the space.
  semgrep: { family: "line", markers: [{ name: "nosemgrep", pattern: / (?<at>nosem)/dgi }] },
  // gitleaks:allow anywhere on the lines of a match, case-sensitive (detect/detect.go).
  gitleaks: { family: "line", markers: [{ name: "gitleaks:allow", pattern: /(?<at>gitleaks:allow)/dg }] },
  // A Python comment holding #, blanks, nosec (bandit/core/manager.py, NOSEC_COMMENT).
  // Any word after it, test id or not, still silences the line.
  bandit: { family: "python", markers: [{ name: "# nosec", pattern: /(?<at>#\s*nosec)/dg }] },
  // # noqa in any case anywhere in a comment; # ruff: noqa and # flake8: noqa
  // on their own line exempt the file (crates/ruff_linter/src/noqa.rs).
  ruff: {
    family: "python",
    markers: [
      { name: "# noqa", pattern: /(?<at>#\s*noqa)/dgi },
      { name: "# {kw}: noqa", pattern: /^(?<at>#\s*(?<kw>flake8|ruff)\s*:\s*[nN][oO][qQ][aA])/dg, ownLine: true },
    ],
  },
  // A comment `# shellcheck` with a disable= key among its keys
  // (src/ShellCheck/Parser.hs, readAnnotation).
  shellcheck: {
    family: "shell",
    markers: [{ name: "# shellcheck disable=", pattern: /^(?<at>#[ \t]*shellcheck)[ \t]+(?:[A-Za-z-]+=(?:'[^'\n]*'|"[^"\n]*"|\S+)[ \t]+)*disable=/dg }],
  },
  // A comment line `# hadolint ignore=`, `# hadolint global ignore=` or
  // `# hadolint stage ignore=` with a rule list (src/Hadolint/Pragma.hs).
  hadolint: {
    family: "dockerfile",
    markers: [{ name: "# hadolint {kw}ignore=", pattern: /^(?<at>#[ \t]*hadolint)[ \t]+(?<kw>(?:global|stage)[ \t]+)?ignore[ \t]*=[ \t]*[DLSC0-9]/dg }],
  },
  // golangci-lint: a // comment that reads nolint after its slashes and
  // spaces, then a space, a colon or its end
  // (pkg/result/processors/nolint_filter.go). gosec, which it runs: #nosec
  // at the start of a comment line, and //gosec:disable (analyzer.go).
  golangci: {
    family: "go",
    markers: [
      { name: "//nolint", pattern: /^(?<at>\/\/[/ ]*nolint)(?:[ :]|$)/dg },
      { name: "#nosec", pattern: /(?:^\/\/[ \t]*|^\/\*\s*|\n[ \t]*)(?<at>#nosec)/dg },
      { name: "//gosec:disable", pattern: /^(?<at>\/\/gosec:disable)(?: |$)/dg },
    ],
  },
  // A Ruby comment holding # rubocop:disable or # rubocop:todo and a cop
  // name or all (lib/rubocop/directive_comment.rb).
  rubocop: {
    family: "ruby",
    markers: [{ name: "# rubocop:{kw}", pattern: /(?<at>#\s*rubocop\s*:\s*(?<kw>disable|todo))\b\s*(?:all|[A-Z]\w+)/dg }],
  },
  // A // or /* */ comment that starts, after blanks, with eslint-disable or
  // oxlint-disable, -line or -next-line, then a blank or its end
  // (crates/oxc_linter/src/disable_directives.rs).
  oxlint: {
    family: "js",
    markers: [{ name: "{kw}", pattern: /^\/[/*]\s*(?<at>(?<kw>(?:eslint|oxlint)-disable(?:-next-line|-line)?))(?=\s|\*\/|$)/dg }],
  },
};

export type MarkerHit = { scanner: BuiltinScanner; line: number; name: string };

// Every suppression marker in `text` that one of `scanners` obeys, with its
// 1-based line, in line order. Each family's comments are found once.
export function findMarkers(text: string, scanners: readonly BuiltinScanner[]): MarkerHit[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const units = new Map<Family | "line", Comment[]>();
  const unitsOf = (family: Family | "line"): Comment[] => {
    let found = units.get(family);
    if (found === undefined) {
      found = family === "line" ? starts.map((start) => lineAt(text, start)) : comments(text, family);
      units.set(family, found);
    }
    return found;
  };

  const hits: MarkerHit[] = [];
  const seen = new Set<string>();
  for (const scanner of scanners) {
    const entry = SUPPRESSION_MARKERS[scanner];
    if (entry === undefined) continue;
    for (const unit of unitsOf(entry.family)) {
      for (const marker of entry.markers) {
        if (marker.ownLine && text.slice(starts[lineOf(unit.start) - 1], unit.start).trim() !== "") continue;
        for (const m of unit.text.matchAll(marker.pattern)) {
          const at = m.indices?.groups?.at?.[0] ?? m.index;
          const line = lineOf(unit.start + at);
          const name = marker.name.replace("{kw}", (m.groups?.kw ?? "").replace(/\s+/g, " "));
          const key = `${scanner}\0${line}\0${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ scanner, line, name });
        }
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function lineAt(text: string, start: number): Comment {
  const end = text.indexOf("\n", start);
  const line = text.slice(start, end < 0 ? text.length : end);
  return { start, text: line.endsWith("\r") ? line.slice(0, -1) : line };
}
