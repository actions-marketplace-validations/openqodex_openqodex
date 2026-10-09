// The mapping keys of a YAML or JSON file (yaml-keys.ts), read the way the
// Kubernetes scanners read them: kube-linter and Checkov obey a suppression
// annotation such as `ignore-check.kube-linter.io/<check>` as a key of an
// object's annotations, whatever style the file writes it in. A reader
// narrower than theirs hides a suppression the change adds.
//
// Failure list, written before the code:
//   1. A key in a flow mapping (`{metadata: {annotations: {k: v}}}`), on one
//      line or across lines, is missed.
//   2. A key in a JSON manifest is missed: minified (`{"k":"v"}`, no blank
//      after the colon) or pretty-printed.
//   3. A key written with escapes (`"a\/b"` in JSON, `"a\x2Fb"` in YAML) is
//      read as written, not as the scanner decodes it.
//   4. A key that reaches the object through an alias or a merge key
//      (`annotations: *common`, `<<: *common`) is missed on the line the
//      change adds.
//   5. The same text in a string value or a comment is read as a key.
//   6. A file the parser cannot read, or one over the size cap, hides a key
//      instead of counting every line that holds the text.
//   7. Hostile input (deep nesting, alias bombs, long lines) takes more than
//      linear time or crashes the run.
//   8. A key's line is wrong.
import { describe, expect, it } from "vitest";
import { MAX_KEY_BYTES, yamlKeys } from "./yaml-keys.js";

const MARK = "ignore-check.kube-linter.io/privileged-container";
const lineOf = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;
// The lines of the units whose text holds the marker.
const hits = (text: string): number[] => {
  const { units } = yamlKeys(text);
  return units.filter((u) => u.text.includes(MARK)).map((u) => lineOf(text, u.start));
};

describe("YAML and JSON keys", () => {
  it("finds a key in a block mapping on its own line (8)", () => {
    const text = `apiVersion: v1\nkind: Pod\nmetadata:\n  annotations:\n    ${MARK}: "needed"\n`;
    expect(hits(text)).toEqual([5]);
    expect(yamlKeys(text).keys).toBe(true);
  });

  it("finds a key in a flow mapping, on one line or across lines (1)", () => {
    expect(hits(`apiVersion: v1\nkind: Pod\nmetadata: {name: a, annotations: {${MARK}: yes}}\n`)).toEqual([3]);
    expect(hits(`metadata: {\n  annotations: {\n    "${MARK}": yes\n  }\n}\n`)).toEqual([3]);
    expect(hits(`- {a: 1, ? ${MARK} : yes}\n`)).toEqual([1]);
  });

  it("finds a key in a JSON manifest, minified or pretty-printed (2)", () => {
    expect(hits(`{"apiVersion":"v1","kind":"Pod","metadata":{"annotations":{"${MARK}":"yes"}}}`)).toEqual([1]);
    expect(hits(`{\n  "metadata": {\n    "annotations": {\n      "${MARK}": "yes"\n    }\n  }\n}\n`)).toEqual([4]);
    expect(hits(`{\n\t"metadata": {\n\t\t"annotations": {"${MARK}": "yes"}\n\t}\n}\n`)).toEqual([3]);
  });

  it("decodes escapes in a quoted key as the scanner does (3)", () => {
    expect(hits(`{"metadata":{"annotations":{"ignore-check.kube-linter.io\\/privileged-container":"yes"}}}`)).toEqual([1]);
    expect(hits(`metadata:\n  annotations:\n    "ignore-check.kube-linter.io\\x2Fprivileged-container": yes\n`)).toEqual([3]);
    expect(hits(`metadata:\n  annotations:\n    "ignore-check.kube-linter.io\\u002Fprivileged-container": yes\n`)).toEqual([3]);
  });

  it("finds a key that reaches an object through an alias or a merge key, on the alias's line (4)", () => {
    const text = [
      "x-common: &common",
      `  ${MARK}: "shared"`,
      "---",
      "apiVersion: v1",
      "kind: Pod",
      "metadata:",
      "  annotations: *common",
      "",
    ].join("\n");
    // Each document is read on its own: an alias names an anchor of its own
    // document, so the first document's anchor is not reached here.
    expect(hits(text)).toEqual([2]);
    const one = ["x-common: &common", `  ${MARK}: "shared"`, "metadata:", "  annotations: *common", "spec:", "  template:", "    metadata:", "      annotations:", "        <<: *common", ""].join("\n");
    expect(hits(one)).toEqual([2, 4, 9]);
    const nested = ["a: &a", `  ${MARK}: x`, "b: &b", "  <<: *a", "c:", "  <<: *b", ""].join("\n");
    expect(hits(nested)).toEqual([2, 4, 6]);
  });

  it("does not read the same text in a string value or a comment as a key (5)", () => {
    const text = `metadata:\n  annotations:\n    note: "${MARK}: no"\n    # ${MARK}: no\n    other: |\n      ${MARK}: no\n`;
    expect(hits(text)).toEqual([]);
  });

  it("counts every line holding the text when the parser cannot read the file (6)", () => {
    const text = `metadata:\n  annotations:\n\t${MARK}: tabs are not indentation\n  - broken: [\n`;
    const out = yamlKeys(text);
    expect(out.keys).toBe(false);
    expect(out.units.filter((u) => u.text.includes(MARK)).map((u) => lineOf(text, u.start))).toEqual([3]);
  });

  it("counts every line holding the text in a file over the size cap (6)", () => {
    const text = `a: ${"x".repeat(MAX_KEY_BYTES)}\nnote: "${MARK}"\n`;
    const out = yamlKeys(text);
    expect(out.keys).toBe(false);
    expect(out.units.filter((u) => u.text.includes(MARK)).map((u) => lineOf(text, u.start))).toEqual([2]);
  });
});

describe("YAML key reading on hostile input (7)", () => {
  const fast = (text: string) => {
    const started = performance.now();
    yamlKeys(text);
    return performance.now() - started;
  };
  const cases: [string, string][] = [
    ["deep flow nesting", `${"[".repeat(100_000)}\n`],
    ["deep block nesting", Array.from({ length: 5_000 }, (_, i) => `${" ".repeat(i)}k${i}:`).join("\n")],
    ["an alias bomb", ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n")],
    ["a merge-key bomb", ["a: &a {k: 1}", ...Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} {${Array.from({ length: 10 }, (_, j) => `<<: *${String.fromCharCode(97 + i)}${j === 0 ? "" : ""}`)[0]}, x${i}: [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]}`)].join("\n")],
  ];
  for (const [what, text] of cases) {
    it(what, () => {
      expect(fast(text)).toBeLessThan(2000);
    });
  }

  // Input that grows with its size is checked by the ratio of two sizes,
  // which a slow runner does not change: a linear reader takes about four
  // times as long for about four times the input, one that rescans sixteen;
  // the bound is the middle of the two.
  // CPU time of the fastest of three runs, after one that is not counted,
  // on flat text. The larger size stays under MAX_KEY_BYTES, past which the
  // raw lines are read instead and the parser goes unmeasured. The bound at
  // 1 MB fails only a gross slowdown: a Linux runner took 2.7 s of wall time
  // for "many keys" at 1.1 MB.
  const MB = 1024 * 1024;
  const timed = (made: string) => {
    const text = Buffer.from(made, "utf8").toString("utf8");
    yamlKeys(text);
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const before = process.cpuUsage();
      yamlKeys(text);
      const used = process.cpuUsage(before);
      runs.push((used.user + used.system) / 1000);
    }
    return Math.min(...runs);
  };
  const lines = (size: number, line: (i: number) => string) => {
    const out: string[] = [];
    let length = 0;
    for (let i = 0; length < size; i++) {
      const l = line(i);
      out.push(l);
      length += l.length + 1;
    }
    return out.join("\n");
  };
  const growing: [string, (size: number) => string][] = [
    ["one long line", (size) => `k: ${"a ".repeat(Math.ceil(size / 2))}\n`],
    ["many keys", (size) => lines(size, (i) => `k${i}: v`)],
  ];
  for (const [what, make] of growing) {
    it(`${what}, at 1 MB and four times that`, () => {
      const small = timed(make(MB));
      expect(MAX_KEY_BYTES).toBeGreaterThan(4 * MB - 64 * 1024);
      const large = timed(make(4 * MB - 64 * 1024));
      expect(large / Math.max(small, 20), `${small.toFixed(0)} ms for 1 MB, ${large.toFixed(0)} ms for 3.94 MB of CPU time`).toBeLessThan(8);
      expect(small).toBeLessThan(8000);
    }, 180_000);
  }
});
