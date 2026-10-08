// The YAML comment reader (comments.ts, family "yaml") and the code-only
// YAML lines (yamlCode) that the suppression table reads for markers a
// scanner obeys as YAML keys, such as kube-linter's annotations.
//
// Failure list, written before the code:
//   1. A `#` inside a quoted scalar ('...' with '' escapes, "..." with
//      backslash escapes) is read as a comment, or a real comment after the
//      closing quote is missed.
//   2. A `#` in a plain scalar with no blank before it (`url: a/#b`) is read
//      as a comment.
//   3. The body of a block scalar (`run: |`, `>-`, `|2+`) is read as YAML,
//      so a `# ...` line of a shell script counts as a comment; or the body
//      runs on past its last line and hides a real comment after it.
//   4. A block scalar in a sequence (`- run: |`, `- |`) ends at the wrong line.
//   5. An apostrophe or a quote inside a plain scalar (`run: echo it's`)
//      opens a string and hides the comment after it.
//   6. A quoted scalar left open at the end of the file hides every comment
//      after its opener.
//   7. A quoted scalar that spans lines: a `#` on its next line is read as
//      a comment.
//   8. Flow collections: a `#` in a quoted item is read as a comment, or
//      the comment after the collection is missed.
//   9. Code-only lines: a key in the code is masked, or the same text in a
//      comment, a quoted value or a block scalar body is not; a quoted key
//      is masked.
//  10. Linear time on hostile input: many unclosed quotes, many block
//      scalar indicators, one very long line.
import { describe, expect, it } from "vitest";
import { comments, yamlCode } from "./comments.js";

const yaml = (...rows: string[]): string => `${rows.join("\n")}\n`;
const texts = (text: string): string[] => comments(text, "yaml").map((c) => c.text);
// The line (1-based) of each comment.
const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;
const commentLines = (text: string): number[] => comments(text, "yaml").map((c) => lineOf(text, c.start));

describe("YAML comments", () => {
  it("a # in a quoted scalar is text; one after the closing quote and a blank is a comment (1)", () => {
    const text = yaml(`a: 'it''s # not' # one`, `b: "say \\" # not" # two`, `c: '#x'`);
    expect(texts(text)).toEqual(["# one", "# two"]);
  });

  it("a # with no blank before it is part of a plain scalar (2)", () => {
    const text = yaml("url: https://example.com/#frag", "tag: a#b # real", "# whole line", "  # indented");
    expect(texts(text)).toEqual(["# real", "# whole line", "# indented"]);
  });

  it("a block scalar's body holds no comment, the indicator line can, and the key after it is read (3)", () => {
    const text = yaml(
      "run: | # on the indicator",
      "  # a shell comment",
      "  echo hi # also shell",
      "",
      "  echo more",
      "next: 1 # after the body",
      "folded: >-",
      "  # text",
      "keep: |2+",
      "    # text",
      "last: x # end",
    );
    expect(texts(text)).toEqual(["# on the indicator", "# after the body", "# end"]);
  });

  it("a block scalar in a sequence ends where its entry ends (4)", () => {
    const text = yaml(
      "steps:",
      "  - run: |",
      "      # script",
      "      echo a",
      "    name: build # after one",
      "  - |",
      "    # body",
      "  - x # after two",
    );
    expect(texts(text)).toEqual(["# after one", "# after two"]);
  });

  it("an apostrophe or quote inside a plain scalar opens no string (5)", () => {
    const text = yaml("run: echo it's here # one", "say: he said \"hi # two", "q: a 'b' # three");
    expect(texts(text)).toEqual(["# one", "# two", "# three"]);
  });

  it("a quoted scalar left open at the end of the file hides nothing after it (6)", () => {
    const text = yaml("a: 'never closed", "b: 1 # one", "c: \"also open", "d: 2 # two");
    expect(texts(text)).toEqual(["# one", "# two"]);
  });

  it("a quoted scalar that spans lines holds no comment on its next line (7)", () => {
    const text = yaml('a: "first', '  # inside', '  end" # after', "b: 'x", "  # in single", "  y' # after single");
    expect(texts(text)).toEqual(["# after", "# after single"]);
    expect(commentLines(text)).toEqual([3, 6]);
  });

  it("a flow collection's quoted items hold no comment; the comment after it counts (8)", () => {
    const text = yaml("list: [a, 'b # c', \"d # e\", f] # one", "map: {k: 'v # w', z: 1} # two", "multi: [a,", "  b, # three", "  c]");
    expect(texts(text)).toEqual(["# one", "# two", "# three"]);
  });

  it("CRLF line ends: a comment's text has no carriage return", () => {
    expect(texts("a: 1 # one\r\nb: |\r\n  # body\r\nc: 2 # two\r\n")).toEqual(["# one", "# two"]);
  });
});

describe("YAML code-only lines (9)", () => {
  const code = (text: string): string[] => yamlCode(text).map((u) => u.text);

  it("keeps keys and plain values, masks comments", () => {
    const text = yaml("metadata:", "  annotations:", "    ignore-check.kube-linter.io/x: \"ok\" # ignore-check.kube-linter.io/y: in a comment");
    const lines = code(text);
    expect(lines[2]).toContain("ignore-check.kube-linter.io/x:");
    expect(lines[2]).not.toContain("ignore-check.kube-linter.io/y");
  });

  it("keeps a quoted key, masks a quoted value", () => {
    const text = yaml(`"ignore-check.kube-linter.io/a": yes`, `'ignore-check.kube-linter.io/b' : yes`, `note: "ignore-check.kube-linter.io/c: no"`, `other: 'ignore-check.kube-linter.io/d: no'`);
    const joined = code(text).join("\n");
    expect(joined).toContain("ignore-check.kube-linter.io/a");
    expect(joined).toContain("ignore-check.kube-linter.io/b");
    expect(joined).not.toContain("ignore-check.kube-linter.io/c");
    expect(joined).not.toContain("ignore-check.kube-linter.io/d");
  });

  it("masks a block scalar's body and the lines of a quoted value that spans lines", () => {
    const text = yaml("script: |", "  ignore-check.kube-linter.io/x: in a script", 'text: "first', "  ignore-check.kube-linter.io/y: in a string\"", "after: 1");
    const lines = code(text);
    expect(lines.join("\n")).not.toContain("ignore-check");
    expect(lines[4]).toBe("after: 1");
  });

  it("gives one unit per line, each starting at its line's offset", () => {
    const text = yaml("a: 1", "b: 2 # c", "d: 3");
    const units = yamlCode(text);
    expect(units.map((u) => u.start)).toEqual([0, 5, 14, 19]);
    expect(units.map((u) => u.text.length)).toEqual([4, 8, 4, 0]);
  });
});

describe("YAML reading takes linear time (10)", () => {
  const N = 100_000;
  const fast = (text: string) => {
    const started = performance.now();
    comments(text, "yaml");
    yamlCode(text);
    return performance.now() - started;
  };
  const cases: [string, string][] = [
    ["many unclosed quotes", `${"a: 'x\nb: \"y\n".repeat(N / 10)}`],
    ["many block scalar indicators", `${"k: |\n  x\n".repeat(N / 4)}`],
    ["a block scalar to the end of the file", `k: |\n${"  # x\n".repeat(N)}`],
    ["one very long line", `k: ${"a #b ".repeat(N)}\n`],
    ["one very long flow line", `k: [${"'a', ".repeat(N)}]\n`],
    ["blanks before a comment", `k:${" ".repeat(N)}# x\n`],
  ];
  for (const [what, text] of cases) {
    it(what, () => {
      expect(fast(text)).toBeLessThan(1000);
    });
  }
});
