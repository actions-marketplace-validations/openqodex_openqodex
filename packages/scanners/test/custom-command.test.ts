// Ways turning a `run` line into an argument list could fail, written before the code:
// 1. A quoted argument with spaces is split into several arguments.
// 2. Quotes are left in the argument, or an empty quoted argument disappears.
// 3. Something a shell would expand is expanded: $VAR, $(cmd), backticks, ~,
//    a glob, ; or | or && starting a second command.
// 4. An unclosed quote runs a half-parsed command instead of being refused.
// 5. {target} is shell-joined into one argument instead of one per file, or a
//    changed file named like a flag reaches the tool as a flag.
// 6. {report} or {repo} inside a longer argument (--output={report}) is not expanded.
import { describe, expect, it } from "vitest";
import { expandArgs, splitCommand } from "../src/custom/command.js";

describe("splitCommand", () => {
  it("keeps a quoted argument with spaces as one argument and drops the quotes (1, 2)", () => {
    expect(splitCommand(`tool --format "{{json .}}" 'a b' "" x`)).toEqual(["tool", "--format", "{{json .}}", "a b", "", "x"]);
    expect(splitCommand(`tool "say \\"hi\\"" it\\'s`)).toEqual(["tool", 'say "hi"', "it's"]);
  });

  it("expands nothing a shell would (3)", () => {
    const line = "tool $HOME $(id) `id` ~/x *.py a;b | c && d";
    expect(splitCommand(line)).toEqual(["tool", "$HOME", "$(id)", "`id`", "~/x", "*.py", "a;b", "|", "c", "&&", "d"]);
  });

  it("refuses an unclosed quote (4)", () => {
    expect(() => splitCommand(`tool "open`)).toThrow(/unclosed quote/);
    expect(() => splitCommand(`tool 'open`)).toThrow(/unclosed quote/);
  });
});

describe("expandArgs", () => {
  it("gives one argument per target file and keeps a flag-shaped file a path (5)", () => {
    const args = expandArgs(["--json", "{target}", "--end"], { report: "/t/r", repo: "/repo", targets: ["a b.yml", "-x.yml"] });
    expect(args).toEqual(["--json", "a b.yml", "./-x.yml", "--end"]);
  });

  it("expands {report} and {repo} inside a longer argument (6)", () => {
    expect(expandArgs(["--output={report}", "--root", "{repo}/src"], { report: "/t/r", repo: "/repo", targets: [] })).toEqual([
      "--output=/t/r",
      "--root",
      "/repo/src",
    ]);
  });
});
