// The benchmark corpus is what the scores are measured against, so each case
// must build, and every planted bug must be where its spec says: the anchor
// text on the anchor line, and a line in its range that a finding may cite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCase, changedLines, git, listCases, readCase, specProblems } from "../lib/cases.mjs";

const ids = listCases();

describe("the benchmark corpus", () => {
  it("has twelve to twenty cases, at least one of them clean", () => {
    expect(ids.length).toBeGreaterThanOrEqual(12);
    expect(ids.length).toBeLessThanOrEqual(20);
    expect(ids.some((id) => readCase(id).clean)).toBe(true);
  });

  for (const id of ids) {
    it(`${id}: builds, and every planted bug is on the line its spec names`, () => {
      const { dir, spec } = buildCase(id);
      const changed = changedLines(dir);
      expect(changed.size, "the change touches no file").toBeGreaterThan(0);
      for (const bug of spec.bugs) {
        const lines = readFileSync(join(dir, bug.file), "utf8").split("\n");
        expect(lines[bug.anchor.line - 1] ?? "", `${bug.id}: ${bug.file}:${bug.anchor.line}`).toContain(bug.anchor.text);
        for (const loc of [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])]) {
          const set = changed.get(loc.file) ?? new Set();
          const citable = [...set].some((n) => n >= loc.lines[0] && n <= loc.lines[1]);
          expect(citable, `${bug.id}: ${loc.file} lines ${loc.lines.join("-")} hold no changed line, so no finding can cite them`).toBe(true);
        }
      }
      for (const x of spec.extras ?? []) {
        expect(readFileSync(join(dir, x.file), "utf8").split("\n").length, `${x.file} is shorter than its extra's range`).toBeGreaterThanOrEqual(x.lines[1]);
      }
      // The base is committed and the change is not.
      expect(git(dir, "log", "--oneline").trim().split("\n")).toHaveLength(1);
      expect(git(dir, "status", "--porcelain").trim()).not.toBe("");
    });
  }

  it("builds the same bytes twice, generated values included", () => {
    const tree = (dir) => {
      git(dir, "add", "-A");
      return git(dir, "write-tree").trim();
    };
    for (const id of ids.filter((x) => (readCase(x).generated ?? []).length > 0)) {
      expect(tree(buildCase(id).dir), id).toBe(tree(buildCase(id).dir));
    }
  });

  it("puts a generated secret in the change only, never in the base commit", () => {
    for (const id of ids) {
      const spec = readCase(id);
      for (const g of spec.generated ?? []) {
        const { dir } = buildCase(id);
        expect(readFileSync(join(dir, g.file), "utf8")).toMatch(/sk_live_[A-Za-z0-9]{24}/);
        const committed = git(dir, "ls-tree", "-r", "--name-only", "HEAD").trim().split("\n");
        for (const path of committed) expect(git(dir, "show", `HEAD:${path}`), `${id}: the base commit holds a key in ${path}`).not.toMatch(/sk_live_/);
      }
    }
  });

  it("rejects a spec with an unknown kind, a reversed range or an anchor outside its range", () => {
    const bug = { id: "b", file: "a.py", lines: [5, 3], anchor: { line: 9, text: "x" }, kind: ["typo"], severity: "major", found_by: ["reasoning"], truth: "t" };
    const problems = specProblems({ id: "x", guards: "g", language: "python", framework: "none", clean: false, bugs: [bug] }, "x");
    expect(problems.join("\n")).toMatch(/lines must be/);
    expect(problems.join("\n")).toMatch(/kind must be/);
    const outside = specProblems({ id: "x", guards: "g", language: "python", framework: "none", clean: false, bugs: [{ ...bug, lines: [1, 3], kind: ["bug"] }] }, "x");
    expect(outside.join("\n")).toMatch(/anchor line is outside lines/);
  });

  it("refuses a plant or an accepted side issue without the words that name it", () => {
    const sound = { id: "b", file: "a.py", lines: [1, 3], anchor: { line: 1, text: "x" }, mentions: ["injection"], kind: ["security"], severity: "major", found_by: ["reasoning"], truth: "t" };
    const base = { id: "x", guards: "g", language: "python", framework: "none", clean: false };
    expect(specProblems({ ...base, bugs: [sound] }, "x")).toEqual([]);
    expect(specProblems({ ...base, bugs: [{ ...sound, mentions: undefined }] }, "x").join("\n")).toMatch(/mentions/);
    expect(specProblems({ ...base, bugs: [sound], extras: [{ file: "a.py", lines: [5, 6], why: "w" }] }, "x").join("\n")).toMatch(/extras\[0\].*mentions/);
  });

  it("gives every plant in the corpus its words", () => {
    for (const id of ids) for (const b of readCase(id).bugs) expect(b.mentions?.length, `${id}/${b.id}`).toBeGreaterThan(0);
  });
});
