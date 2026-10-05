// The suppression marker table and the comment tokenizers, on file text.
// Each case was checked against the scanner itself: bandit 1.9.4, ruff
// 0.8.4, semgrep 1.94.0, gitleaks 8.21.2, shellcheck 0.10.0, hadolint
// 2.15.1 and oxlint 1.71.0 were run on the same lines, and the cases for
// rubocop 1.69.2 and golangci-lint 2.12.2 follow their source, since this
// Mac has no usable Ruby or Go.
//
// Failure list, written before the code:
//   1. A marker the scanner obeys only in a comment is reported when it sits
//      in a one-line string of the same language.
//   2. The same, in a string that spans lines: a Python triple-quoted
//      string, a JavaScript template literal, a Go raw string, a shell or
//      Dockerfile heredoc, a Ruby heredoc or %-literal.
//   3. A marker in a real comment is missed: a whole-line comment, one after
//      code, a block comment, or one after a string or a regular expression
//      that holds a quote or a comment opener.
//   4. A marker semgrep or gitleaks obeys anywhere on a line is missed
//      because it sits in a string.
//   5. A marker is matched more loosely or more strictly than its scanner
//      matches it (case, spacing, its place in the comment).
//   6. The line is wrong for a marker inside a block comment that spans
//      lines, or in a file with CRLF line ends.
//   7. A scanner with no inline marker (actionlint, brakeman, osv-scanner,
//      sqllint) reports one.
//   8. The name a candidate prints holds text from the line beyond the
//      marker, such as a secret.

import { describe, expect, it } from "vitest";
import type { BuiltinScanner } from "@openqodex/core";
import { findMarkers } from "./suppression.js";

const lines = (scanner: BuiltinScanner, text: string): number[] =>
  findMarkers(text, [scanner]).map((m) => m.line);

const src = (...rows: string[]): string => `${rows.join("\n")}\n`;

describe("bandit, # nosec in Python comments", () => {
  it("finds it in a comment after code and in a later comment on the line, never in a string (1, 3, 5)", () => {
    const text = src(
      'subprocess.call("ls", shell=True)  # nosec',
      'subprocess.call("ls", shell=True); s = "# nosec"',
      'subprocess.call("ls", shell=True)  #nosec B602',
      'subprocess.call("ls", shell=True)  # foo # nosec',
      'subprocess.call("ls", shell=True)  # NOSEC',
      "s = '# nosec'  # plain",
    );
    expect(lines("bandit", text)).toEqual([1, 3, 4]);
  });

  it("ignores it inside a triple-quoted string, and finds a comment after the string closes (2, 3)", () => {
    const text = src(
      's = """',
      "# nosec",
      '"""; x = 1  # nosec',
      "t = '''a # nosec",
      "'''",
      "u = f'{x}#nosec'",
      'v = "a \\" # nosec"',
    );
    expect(lines("bandit", text)).toEqual([3]);
  });
});

describe("ruff, # noqa in Python comments", () => {
  it("finds # noqa in any case anywhere in a comment, and # ruff: noqa only on its own line (1, 5)", () => {
    const text = src(
      "import os, sys  # noqa",
      'import json, re; t = "# noqa"',
      "import csv, io  # foo # NOQA",
      "# ruff: noqa: F401",
      "x = 1  # ruff: noqa",
      "  # flake8: noqa",
      "# ruff noqa",
    );
    const found = findMarkers(text, ["ruff"]);
    expect(found.map((m) => [m.line, m.name])).toEqual([
      [1, "# noqa"],
      [3, "# noqa"],
      [4, "# ruff: noqa"],
      [6, "# flake8: noqa"],
    ]);
  });
});

describe("semgrep and gitleaks obey their marker anywhere on the line", () => {
  it("semgrep: a space then nosem in any case, in a comment or a string, never without the space (4, 5)", () => {
    const text = src(
      "eval(x)  # nosemgrep",
      "eval(x)  #nosemgrep",
      'eval(x); s = " nosemgrep"',
      "eval(x)  # NOSEM",
      "eval(x)  #\tnosemgrep",
      "plain line",
    );
    expect(lines("semgrep", text)).toEqual([1, 3, 4]);
  });

  it("gitleaks: gitleaks:allow, case-sensitive, in a comment or a string (4, 5)", () => {
    const text = src('A = "x"  # gitleaks:allow', 'B = "x gitleaks:allow"', 'C = "x"  # GITLEAKS:ALLOW');
    expect(lines("gitleaks", text)).toEqual([1, 2]);
  });
});

describe("shellcheck, # shellcheck disable= in shell comments", () => {
  it("finds the directive with or without a space and after another key, never in a string, a heredoc or a word (1, 2, 5)", () => {
    const text = src(
      "echo start",
      "# shellcheck disable=SC2086",
      'echo "# shellcheck disable=SC2086"; echo $B',
      "cat <<EOF",
      "# shellcheck disable=SC2086",
      "EOF",
      "echo x#shellcheck disable=SC2086",
      "# shellcheck source=/dev/null disable=SC2086",
      "#shellcheck disable=SC2086",
      "# shellcheck enable=require-variable-braces",
      "cat <<-'END' | tr a b",
      "\t# shellcheck disable=SC2086",
      "\tEND",
      "echo '# shellcheck disable=SC2086",
      "# shellcheck disable=SC2086'",
      "echo ${#arr[@]} $# # shellcheck disable=SC2086",
    );
    expect(lines("shellcheck", text)).toEqual([2, 8, 9, 16]);
  });
});

describe("hadolint, # hadolint ignore= on a Dockerfile comment line", () => {
  it("finds ignore, global ignore and stage ignore pragmas, never in an instruction or a heredoc (1, 2, 5)", () => {
    const text = src(
      "FROM debian:12",
      "# hadolint ignore=DL3008",
      'RUN echo "# hadolint ignore=DL3008"',
      "   #   hadolint   ignore=DL3008",
      "#hadolint ignore=DL3008,SC2086",
      "# hadolint global ignore=DL3008",
      "# hadolint stage ignore=DL3006",
      "RUN <<EOF",
      "# hadolint ignore=DL3008",
      "EOF",
      "# hadolint shell=bash",
      "RUN true # hadolint ignore=DL3008",
    );
    expect(lines("hadolint", text)).toEqual([2, 4, 5, 6, 7]);
  });
});

describe("oxlint, eslint-disable and oxlint-disable at the start of a JavaScript comment", () => {
  it("finds line and block directives, never in a string, a template or later in a comment (1, 2, 3, 5)", () => {
    const text = src(
      "function f() {",
      "  debugger; // eslint-disable-line",
      '  debugger; const s = "// eslint-disable-line";',
      "  // eslint-disable-next-line",
      "  const t = `",
      "// eslint-disable-next-line",
      "`; debugger;",
      "  /* oxlint-disable-next-line */",
      "  debugger; /*eslint-disable-line*/",
      '  const r = /"/; debugger; // eslint-disable-line',
      "  debugger; // foo eslint-disable-line",
      "  const u = `${'`'}`; // oxlint-disable-line no-debugger",
      "  const w = `a ${ { b: `// eslint-disable` }.b } c`; // eslint-disable-line",
      "  const q = a / b; // eslint-disable-line",
      "}",
      "/* eslint-disable */",
      "/** eslint-disable */",
    );
    expect(findMarkers(text, ["oxlint"]).map((m) => [m.line, m.name])).toEqual([
      [2, "eslint-disable-line"],
      [4, "eslint-disable-next-line"],
      [8, "oxlint-disable-next-line"],
      [9, "eslint-disable-line"],
      [10, "eslint-disable-line"],
      [12, "oxlint-disable-line"],
      [13, "eslint-disable-line"],
      [14, "eslint-disable-line"],
      [16, "eslint-disable"],
    ]);
  });

  it("puts a directive inside a block comment that spans lines on its own line (6)", () => {
    const text = src("/*", "  eslint-disable no-console", "*/", "/* note", "eslint-disable */");
    expect(lines("oxlint", text)).toEqual([2]);
  });
});

describe("golangci-lint, //nolint, #nosec and //gosec:disable in Go comments", () => {
  it("finds //nolint as golangci-lint parses it, never in a block comment or a string (1, 5)", () => {
    const text = src(
      "x := f() //nolint",
      "x := f() // nolint:errcheck",
      "x := f() /// nolint",
      'x := "//nolint"',
      "x := f() /* nolint */",
      "x := f() //nolintfoo",
      "x := f() //nolint:gosec,errcheck // reason",
    );
    expect(lines("golangci", text)).toEqual([1, 2, 3, 7]);
  });

  it("finds gosec's #nosec at the start of a comment line and //gosec:disable, never in a raw string (1, 2, 5, 6)", () => {
    const text = src(
      "pw := \"x\" // #nosec G101",
      "pw := \"x\" //#nosec",
      "pw := \"x\" // see #nosec",
      "q := `",
      "// #nosec",
      "`",
      "/*",
      "  #nosec G204",
      "*/",
      "c := '\\'' //gosec:disable G101",
      "c := 1 //gosec:disabled",
    );
    expect(findMarkers(text, ["golangci"]).map((m) => [m.line, m.name])).toEqual([
      [1, "#nosec"],
      [2, "#nosec"],
      [8, "#nosec"],
      [10, "//gosec:disable"],
    ]);
  });
});

describe("rubocop, # rubocop:disable and # rubocop:todo in Ruby comments", () => {
  it("finds the directive in a comment and an =begin block, never in strings, heredocs or %-literals (1, 2, 3, 5)", () => {
    const text = src(
      "x = eval(y) # rubocop:disable Security/Eval",
      'x = "# rubocop:disable Security/Eval"',
      "x = 1 # rubocop:todo Lint/UselessAssignment",
      "# rubocop : disable all",
      "s = <<~SQL",
      "  # rubocop:disable Security/Eval",
      "SQL",
      "t = %q(# rubocop:disable all (nested))",
      'u = "#{a + "b"} # rubocop:disable all"',
      "=begin",
      "# rubocop:disable all",
      "=end",
      "# rubocop:enable all",
      "# rubocop:disable lower/case",
      "v = a ? 1 : 2 # rubocop:disable Style/Ternary",
    );
    expect(findMarkers(text, ["rubocop"]).map((m) => [m.line, m.name])).toEqual([
      [1, "# rubocop:disable"],
      [3, "# rubocop:todo"],
      [4, "# rubocop:disable"],
      [11, "# rubocop:disable"],
      [15, "# rubocop:disable"],
    ]);
  });
});

describe("lines and names", () => {
  it("counts lines in a file with CRLF line ends (6)", () => {
    const text = "import os\r\nx = 1  # noqa\r\ny = 2 # nosec\r\n";
    expect(findMarkers(text, ["ruff", "bandit"]).map((m) => [m.scanner, m.line])).toEqual([
      ["ruff", 2],
      ["bandit", 3],
    ]);
  });

  it("a scanner with no inline marker reports none (7)", () => {
    const text = src("# nosec # noqa nosemgrep gitleaks:allow", "-- nosemgrep");
    for (const scanner of ["actionlint", "brakeman", "osv-scanner", "sqllint"] as const) {
      expect(findMarkers(text, [scanner]), scanner).toEqual([]);
    }
  });

  it("names the marker only, never the rest of the line (8)", () => {
    const key = `sk_live_${"a1b2c3d4".repeat(3)}`;
    const text = src(`KEY = "${key}"  # gitleaks:allow nosemgrep # nosec ${key} # noqa: ${key}`);
    const found = findMarkers(text, ["gitleaks", "semgrep", "bandit", "ruff"]);
    expect(found.map((m) => [m.scanner, m.name])).toEqual([
      ["gitleaks", "gitleaks:allow"],
      ["semgrep", "nosemgrep"],
      ["bandit", "# nosec"],
      ["ruff", "# noqa"],
    ]);
    for (const m of found) expect(m.name).not.toContain(key);
  });
});
