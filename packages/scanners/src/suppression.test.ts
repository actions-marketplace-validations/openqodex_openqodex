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
// Added after the security check of the first version, so the detector is
// never narrower than the scanner:
//   9. A form the scanner obeys is not matched: semgrep's marker without the
//      space before it, ruff's isort action comments, shellcheck's
//      extended-analysis=false, golangci-lint's generated-file header.
//  10. A comment the scanner reads is taken for a string: a shellcheck
//      directive inside "$( )", backticks or a heredoc's $( ); a comment in a
//      Python 3.12 f-string field; a JavaScript or Ruby regular expression
//      taken for a division, which then opens a string.
// Added after the code review of the second version:
//  11. A hostile line makes a pattern or a reader take more than linear time
//      and hang the run on a small file.
//  12. shellcheck keys written with no blank between them are not read:
//      `source='/dev/null'disable=SC2086`.
//  13. A heredoc's end word is read short (`<<EOF.JSON` as EOF), so the end
//      line is never found and the rest of the file is taken for its body.
//  14. A Dockerfile heredoc opens where BuildKit opens none (`ENV X=<<EOF`),
//      and swallows a later `# hadolint ignore=`.
//  15. A string, heredoc, template, raw string or block comment left open
//      at the end of the file hides every marker after its opener.
// Added after the second code review:
//  16. 1 MB of generated input takes a second or more: thousands of distinct
//      heredoc words left open, a heredoc word made of 100,000 quote pairs,
//      many unclosed openers of each kind, one very long line, deep nesting.
//  17. A construct read wrongly hides a later real comment: an f-string
//      field whose format spec is never closed; in Ruby, `x /y` read as a
//      regular expression; in JavaScript, `} / 2` read as one.
// Added after the third code review:
//  18. A $( ) left open in each of many heredoc bodies makes each nested
//      read run to the end of the file and the next level read it again:
//      exponential work.
//  19. A shell heredoc end word is read other than the way shellcheck reads
//      it, so the body runs on and an apostrophe in it swallows a later
//      directive: `<<"E\"OF"` ends at `E\"OF`, `<<E"O"F` at `E"O"F`, and
//      an end line may carry trailing blanks.

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
  it("semgrep: nosem in any case, in a comment or a string, with or without a space before it (4, 5, 9)", () => {
    // semgrep 1.94.0 itself needs the space; its documentation only asks for
    // a comment, so `#nosemgrep` and a tab are flagged too (over-flagged).
    const text = src(
      "eval(x)  # nosemgrep",
      "eval(x)  #nosemgrep",
      'eval(x); s = " nosemgrep"',
      "eval(x)  # NOSEM",
      "eval(x)  #\tnosemgrep",
      "eval(x) //nosemgrep: rule.id",
      "plain line",
    );
    expect(lines("semgrep", text)).toEqual([1, 2, 3, 4, 5, 6]);
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

describe("never narrower than the scanner", () => {
  it("ruff: the isort action comments that switch off import sorting (9)", () => {
    const text = src(
      "# isort: skip_file",
      "import b, a  # isort:skip",
      "# ruff: isort: off",
      "# isort: split",
      "x = 'isort: skip'",
    );
    expect(findMarkers(text, ["ruff"]).map((m) => [m.line, m.name])).toEqual([
      [1, "# isort: skip_file"],
      [2, "# isort: skip"],
      [3, "# isort: off"],
    ]);
  });

  it("bandit and ruff: a comment inside a Python 3.12 f-string field, never a # in a format spec (10)", () => {
    const text = src(
      'x = f"{', "    a  # nosec", '}" + "y"  # nosec',
      'y = f"{v:#x}"  # nosec',
      'z = f"{d:{w}}" "# nosec"',
      "t = f'''{a!r} # nosec'''",
      'u = rf"""{', "    b  # nosec", '}"""',
    );
    expect(lines("bandit", text)).toEqual([2, 3, 4, 8]);
  });

  it("shellcheck: extended-analysis=false, and directives inside \"$( )\", backticks and a heredoc's $( ) (9, 10)", () => {
    const text = src(
      "echo start",
      'x="$(',
      "# shellcheck disable=SC2086",
      "echo $A",
      ')"',
      "y=`",
      "# shellcheck disable=SC2086",
      "echo $C`",
      "cat <<EOF",
      "$(",
      "# shellcheck disable=SC2086",
      "echo $E",
      ")",
      "# shellcheck disable=SC2086",
      "EOF",
      "cat <<'EOF'",
      "$(",
      "# shellcheck disable=SC2086",
      ")",
      "EOF",
      "# shellcheck extended-analysis=false",
      'z="a $(echo "# shellcheck disable=SC2086") b"',
    );
    expect(findMarkers(text, ["shellcheck"]).map((m) => [m.line, m.name])).toEqual([
      [3, "# shellcheck disable="],
      [7, "# shellcheck disable="],
      [11, "# shellcheck disable="],
      [21, "# shellcheck extended-analysis=false"],
    ]);
  });

  it("golangci-lint: a generated-file comment before the package clause, in any case (9)", () => {
    const header = src("// Code generated by protoc-gen-go. DO NOT EDIT.", "", "package api", "", "// do not edit below", "var x = 1");
    expect(findMarkers(header, ["golangci"]).map((m) => [m.line, m.name])).toEqual([[1, "a generated-file comment"]]);
    const block = src("/*", " * Autogenerated file, keep out.", " */", "package api // Do Not Edit");
    expect(lines("golangci", block)).toEqual([2, 4]);
  });

  it("oxlint: a regular expression after if (...) or a postfix ++ is never taken for a string (10)", () => {
    const text = src(
      "#!/usr/bin/env node",
      "if (a) /'/.test(b); // eslint-disable-line",
      "while (x) /\"/.exec(y); // eslint-disable-line",
      "n = a++ / b; // eslint-disable-line",
      "m = (a) / 2; // eslint-disable-line",
    );
    expect(lines("oxlint", text)).toEqual([2, 3, 4, 5]);
  });

  it("rubocop: a regular expression argument after a method name is never taken for a string (10)", () => {
    const text = src(
      "parts = line.split /'/ # rubocop:disable Style/RegexpLiteral",
      "half = total / 2 # rubocop:disable Lint/Foo",
      "rest = 1",
      "# rubocop:todo Lint/Bar",
    );
    expect(lines("rubocop", text)).toEqual([1, 2, 4]);
  });
});

describe("keys and heredoc words read as the scanners read them", () => {
  it("shellcheck: keys with no blank between them (12)", () => {
    // shellcheck 0.10.0 obeys this disable (checked against the binary).
    const text = src("echo start", "# shellcheck source='/dev/null'disable=SC2086", "echo $A", "# shellcheck disable=2086source=/dev/null", "echo $B");
    expect(lines("shellcheck", text)).toEqual([2, 4]);
  });

  it("shell: the whole end word of a heredoc, quoted, escaped or with a dot (13)", () => {
    // shellcheck 0.10.0 ends each of these heredocs at the line shown.
    const text = src(
      "cat <<EOF.JSON",
      "# shellcheck disable=SC2086",
      "EOF.JSON",
      "# shellcheck disable=SC2086",
      'cat <<"X Y"',
      "# shellcheck disable=SC2086",
      "X Y",
      "# shellcheck disable=SC2086",
      "cat <<-\\END",
      "\t# shellcheck disable=SC2086",
      "\tEND",
      "# shellcheck disable=SC2086",
    );
    expect(lines("shellcheck", text)).toEqual([4, 8, 12]);
  });

  it("shell: the end word and end line as shellcheck reads them (19)", () => {
    // shellcheck 0.10.0 ends each heredoc at the line shown and obeys the
    // directive after it (checked against the binary).
    for (const [opener, end] of [
      ['cat <<"E\\"OF"', 'E\\"OF'],
      ["cat <<'E\\\"OF'", 'E\\"OF'],
      ['cat <<E"O"F', 'E"O"F'],
      ["cat <<EOF", "EOF  "],
    ] as const) {
      const text = src("echo start", opener, "it's here", end, "# shellcheck disable=SC2086", "echo $A", "echo 'done'");
      expect(lines("shellcheck", text), opener).toEqual([5]);
    }
  });

  it("Dockerfile: a heredoc opens only in RUN, COPY and ADD, at the start of a word (14)", () => {
    // hadolint 2.15.1 obeys line 3 (checked against the binary).
    const text = src(
      "FROM debian:12",
      "ENV MARKER=<<EOF",
      "# hadolint ignore=DL3008",
      "RUN cat<<EOF",
      "# hadolint ignore=DL3009",
      "COPY <<EOF /etc/x",
      "# hadolint ignore=DL3010",
      "EOF",
      "run echo <<'END' \\",
      "  && true",
      "# hadolint ignore=DL3011",
      "END",
      "# hadolint ignore=DL3012",
    );
    expect(lines("hadolint", text)).toEqual([3, 5, 13]);
  });
});

describe("an opener left open at the end of the file hides nothing after it (15)", () => {
  it("python: a triple-quoted string and a triple-quoted f-string", () => {
    expect(lines("bandit", src("x = '''", "y = 1  # nosec"))).toEqual([2]);
    expect(lines("bandit", src('x = f"""{a}', "y = 1  # nosec"))).toEqual([2]);
  });

  it("shell: a heredoc, a single-quoted and a double-quoted string, a $( )", () => {
    for (const opener of ["cat <<EOF", "echo 'abc", 'echo "abc', "x=$(echo"]) {
      expect(lines("shellcheck", src("echo start", opener, "# shellcheck disable=SC2086", "echo $A")), opener).toEqual([3]);
    }
  });

  it("Dockerfile: a heredoc", () => {
    expect(lines("hadolint", src("FROM debian:12", "RUN <<EOF", "# hadolint ignore=DL3008", "RUN true"))).toEqual([3]);
  });

  it("ruby: a heredoc, a double-quoted string, a %-literal and an =begin block", () => {
    for (const opener of ["s = <<~SQL", 's = "abc #{x}', "t = %q(abc", "=begin"]) {
      expect(lines("rubocop", src(opener, "x = 1 # rubocop:disable Lint/Foo")), opener).toEqual([2]);
    }
  });

  it("javascript: a template literal and a block comment", () => {
    for (const opener of ["const t = `abc ${x}", "/* note"]) {
      expect(lines("oxlint", src(opener, "debugger; // eslint-disable-line")), opener).toEqual([2]);
    }
  });

  it("go: a raw string and a block comment", () => {
    for (const opener of ["q := `abc", "/* note"]) {
      expect(lines("golangci", src(opener, "x := f() //nolint")), opener).toEqual([2]);
    }
  });
});

describe("a construct read wrongly hides no later comment (17)", () => {
  it("python: an f-string field whose format spec is never closed", () => {
    expect(lines("bandit", src('x = f"{a:>10"', "y = 1  # nosec"))).toEqual([2]);
    expect(lines("bandit", src('x = f"""{a:', "y = 1  # nosec"))).toEqual([2]);
  });

  it("ruby: a local variable, a blank and a slash, read as a regular expression", () => {
    expect(lines("rubocop", src("half = total /2 # rubocop:disable Lint/Foo"))).toEqual([1]);
  });

  it("javascript: a division after a closing brace, read as a regular expression", () => {
    expect(lines("oxlint", src("x = {a: 1}.a } / 2; // eslint-disable-line"))).toEqual([1]);
  });
});

describe("linear time on hostile input (11)", () => {
  // Each input is large enough that a pattern or reader with quadratic or
  // exponential work takes minutes; a linear one takes milliseconds.
  const N = 100_000;
  const fast = (scanner: BuiltinScanner, text: string) => {
    const started = performance.now();
    findMarkers(text, [scanner]);
    return performance.now() - started;
  };
  const cases: [BuiltinScanner, string, string][] = [
    ["shellcheck", "a directive with many keys, then a bad one", `# shellcheck ${"source='x' ".repeat(2000)}! disable=SC2086\n`],
    ["shellcheck", "a directive with many keys and no disable", `# shellcheck ${"source='x' ".repeat(N / 10)}!\n# shellcheck ${"extended-analysis=".repeat(N / 10)}\n`],
    ["shellcheck", "openers left open", `echo start\n${"'\"`$(<<EOF\n".repeat(N / 10)}`],
    ["shellcheck", "deep $( )", `x=${"$(".repeat(N)}\n`],
    ["semgrep", "a long line", `${"nose".repeat(N)}\n`],
    ["gitleaks", "a long line", `${"gitleaks:allo".repeat(N / 4)}\n`],
    ["bandit", "blanks after #", `#${" ".repeat(N)}x\n${"# ".repeat(N)}\n`],
    ["ruff", "blanks after # and isort", `#${" ".repeat(N)}x\n${"isort: ".repeat(N / 4)}\n`],
    ["bandit", "openers left open", `${"'''\"\"\"f'''{".repeat(N / 10)}\n`],
    ["bandit", "deep f-string fields", `x = f"${"{a:".repeat(N)}\n`],
    ["hadolint", "heredocs left open", `FROM a\n${"RUN <<EOF\n".repeat(N / 10)}`],
    ["hadolint", "blanks after #", `#${" ".repeat(N)}hadolint\n`],
    ["oxlint", "openers left open", `${"`/*(".repeat(N / 4)}\n`],
    ["oxlint", "blanks after //", `//${" ".repeat(N)}x\n`],
    ["golangci", "openers left open and package lines in comments", `${"/*\npackage x\n*/\n".repeat(N / 10)}${"`".repeat(N / 10)}\n`],
    ["golangci", "blanks before #nosec", `/*\n${" ".repeat(N)}x\n*/\n`],
    ["rubocop", "openers left open", `${'=begin\n"#{%q(<<~A\n'.repeat(N / 10)}`],
    ["rubocop", "blanks in a directive", `#${" ".repeat(N)}rubocop${" ".repeat(N)}:x\n`],
  ];
  for (const [scanner, what, text] of cases) {
    it(`${scanner}: ${what}`, () => {
      expect(fast(scanner, text)).toBeLessThan(1000);
    });
  }
});

describe("linear time on 1 MB of generated input, per reader family (16)", () => {
  const MB = 1024 * 1024;
  // `unit` repeated to about 1 MB; `(k) => string` gives each repeat its own text.
  const fill = (unit: string | ((k: number) => string)) => {
    const parts: string[] = [];
    let size = 0;
    for (let k = 0; size < MB; k++) {
      const part = typeof unit === "string" ? unit : unit(k);
      parts.push(part);
      size += part.length;
    }
    return parts.join("");
  };
  const fast = (scanner: BuiltinScanner, text: string) => {
    const started = performance.now();
    findMarkers(text, [scanner]);
    return performance.now() - started;
  };
  const cases: [BuiltinScanner, string, string][] = [
    ["semgrep", "one very long line", fill("x nose ")],
    ["bandit", "many unclosed openers of each kind", fill((k) => [`a = '''${k}\n`, `b = """${k}\n`, `c = f'''{${k}\n`, `d = f"{e:${k}\n`, `g = '${k}\n`][k % 5] as string)],
    ["bandit", "one very long line", `x = ${fill("'a' + f\"{b}\" + ")}1  # nosec\n`],
    ["bandit", "deep nesting", `x = f"${fill("{a:")}"\n`],
    ["shellcheck", "many unclosed openers of each kind", fill((k) => [`echo '${k}\n`, `echo "${k}\n`, `echo $'${k}\n`, `x=$(echo ${k}\n`, `y=\`echo ${k}\n`][k % 5] as string)],
    ["shellcheck", "many distinct heredoc words", fill((k) => `cat <<E${k}\n`)],
    ["shellcheck", "one very long line", `cat <<${fill('""')}\nEOF\n`],
    ["shellcheck", "one very long line of heredocs", `cat ${fill('<<"a" ')}\n`],
    ["shellcheck", "deep nesting", `x="${fill("$(\"")}"\n`],
    ["shellcheck", "a $( ) left open in every heredoc body (18)", fill("cat <<E\n$(echo\nE\n")],
    ["shellcheck", "backticks left open in every heredoc body (18)", fill("cat <<E\n`echo\nE\n")],
    ["hadolint", "many distinct heredoc words", `FROM a\n${fill((k) => `RUN <<E${k}\n`)}`],
    ["hadolint", "one very long line", `FROM a\nRUN ${fill("<<a ")}\n`],
    ["hadolint", "deep nesting", `FROM a\n${fill("RUN a \\\n")}`],
    ["rubocop", "many unclosed openers of each kind", fill((k) => [`a = "${k}\n`, `b = '${k}\n`, `c = %q(${k}\n`, `=begin ${k}\n`, `d = "#{${k}\n`][k % 5] as string)],
    ["rubocop", "many distinct heredoc words", fill((k) => `x = <<~E${k}\n`)],
    ["rubocop", "one very long line", `x = ${fill('"a" + ')}1 # rubocop:disable Lint/Foo\n`],
    ["rubocop", "deep nesting", `x = ${fill('"#{')}\n`],
    ["oxlint", "many unclosed openers of each kind", fill((k) => [`a = \`${k}\n`, `/* ${k}\n`, `b = "${k}\n`, `c = /${k}\n`, `d = \`\${${k}\n`][k % 5] as string)],
    ["oxlint", "one very long line", `x = ${fill("a / b / ")}1; // eslint-disable-line\n`],
    ["oxlint", "deep nesting", `x = ${fill("`${")}\n`],
    ["golangci", "many unclosed openers of each kind", fill((k) => [`a := \`${k}\n`, `/* ${k}\n`, `b := "${k}\n`][k % 3] as string)],
    ["golangci", "one very long line", `x := ${fill('"a" + ')}1 //nolint\n`],
    ["golangci", "deep nesting and package lines in comments", fill("/*\npackage x\n*/\n")],
  ];
  for (const [scanner, what, text] of cases) {
    it(`${scanner}: ${what}`, () => {
      expect(fast(scanner, text)).toBeLessThan(1000);
    });
  }
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
