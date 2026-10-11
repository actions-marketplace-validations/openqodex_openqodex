// The benchmark corpus is what the scores are measured against, so each case
// must build, and every planted bug must be where its spec says: the anchor
// text on the anchor line, and a line in its range that a finding may cite.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildCase, changedLines, diffOf, git, labelProblems, listCases, readCase, readLock, specProblems } from "../lib/cases.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

// Each case is built into a temp folder this file removes at the end.
const build = (id) => buildCase(id, join(tempDir(`oq-bench-${id}-`), "repo"));

const ids = listCases();
// A retired case keeps its folder so old runs can be rebuilt, but no new run uses it.
const lock = readLock();
const active = ids.filter((id) => lock.cases[id]?.retired !== true);

describe("the benchmark corpus", () => {
  it("has twelve to twenty-four active cases, at least one of them clean", () => {
    expect(active.length).toBeGreaterThanOrEqual(12);
    expect(active.length).toBeLessThanOrEqual(24);
    expect(active.some((id) => readCase(id).clean)).toBe(true);
  });

  for (const id of ids) {
    it(`${id}: builds, and every planted bug is on the line its spec names`, () => {
      const { dir, spec } = build(id);
      const diff = diffOf(dir);
      const changed = diff.changed;
      expect(changedLines(dir)).toEqual(changed);
      expect(changed.size, "the change touches no file").toBeGreaterThan(0);
      for (const bug of spec.bugs) {
        const lines = readFileSync(join(dir, bug.file), "utf8").split("\n");
        expect(lines[bug.anchor.line - 1] ?? "", `${bug.id}: ${bug.file}:${bug.anchor.line}`).toContain(bug.anchor.text);
        for (const loc of [{ file: bug.file, lines: bug.lines }, ...(bug.also ?? [])]) {
          const set = changed.get(loc.file) ?? new Set();
          const citable = [...set].some((n) => n >= loc.lines[0] && n <= loc.lines[1]);
          expect(citable, `${bug.id}: ${loc.file} lines ${loc.lines.join("-")} hold no changed line, so no finding can cite them`).toBe(true);
        }
        // Evidence is the proof that lives outside the changed lines: each place exists; the labels agree with the diff.
        for (const ev of bug.evidence) {
          expect(existsSync(join(dir, ev.file)), `${bug.id}: evidence ${ev.file} is not in the repository`).toBe(true);
          expect(readFileSync(join(dir, ev.file), "utf8").split("\n").length, `${bug.id}: ${ev.file} is shorter than its evidence`).toBeGreaterThanOrEqual(ev.lines[1]);
        }
        expect(labelProblems(bug, diff), bug.id).toEqual([]);
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
      expect(tree(build(id).dir), id).toBe(tree(build(id).dir));
    }
  });

  it("puts a generated secret in the change only, never in the base commit", () => {
    for (const id of ids) {
      const spec = readCase(id);
      for (const g of spec.generated ?? []) {
        const { dir } = build(id);
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
    const sound = { id: "b", file: "a.py", lines: [1, 3], anchor: { line: 1, text: "x" }, mentions: ["injection"], kind: ["security"], class: "sql-injection", tags: [], evidence: [], severity: "major", found_by: ["reasoning"], truth: "t" };
    const base = { id: "x", guards: "g", language: "python", framework: "none", clean: false };
    expect(specProblems({ ...base, bugs: [sound] }, "x")).toEqual([]);
    expect(specProblems({ ...base, bugs: [{ ...sound, mentions: undefined }] }, "x").join("\n")).toMatch(/mentions/);
    expect(specProblems({ ...base, bugs: [sound], extras: [{ file: "a.py", lines: [5, 6], why: "w" }] }, "x").join("\n")).toMatch(/extras\[0\].*mentions/);
  });

  it("gives every plant in the corpus its words", () => {
    for (const id of ids) for (const b of readCase(id).bugs) expect(b.mentions?.length, `${id}/${b.id}`).toBeGreaterThan(0);
  });

  // The labels must say what the diff shows, or the reviewer loop reads a cause the case does not have.
  const labelled = { id: "b", file: "a.py", lines: [2, 3], anchor: { line: 2, text: "x" }, mentions: ["x"], kind: ["bug"], class: "contract-break", tags: [], evidence: [], severity: "major", found_by: ["reasoning"], truth: "t" };
  const shape = (changed, deletedAfter = {}) => ({
    changed: new Map(Object.entries(changed).map(([f, lines]) => [f, new Set(lines)])),
    deletedAfter: new Map(Object.entries(deletedAfter)),
  });

  it("refuses evidence inside the bug's own lines, which is the bug's location and not proof outside it", () => {
    const base = { id: "x", guards: "g", language: "python", framework: "none", clean: false };
    expect(specProblems({ ...base, bugs: [{ ...labelled, evidence: [{ file: "a.py", lines: [3, 5] }] }] }, "x").join("\n")).toMatch(/overlaps/);
    expect(specProblems({ ...base, bugs: [{ ...labelled, also: [{ file: "b.py", lines: [7, 8] }], evidence: [{ file: "b.py", lines: [8, 8] }] }] }, "x").join("\n")).toMatch(/overlaps/);
    expect(specProblems({ ...base, bugs: [{ ...labelled, evidence: [{ file: "a.py", lines: [9, 9] }] }] }, "x")).toEqual([]);
  });

  it("refuses needs-callers when no evidence lies in a caller or registration outside the diff", () => {
    const diff = shape({ "a.py": [2, 3, 9] });
    expect(labelProblems({ ...labelled, tags: ["needs-callers"], evidence: [{ file: "a.py", lines: [7, 7] }] }, diff).join("\n")).toMatch(/needs-callers/);
    expect(labelProblems({ ...labelled, tags: ["needs-callers"], evidence: [{ file: "caller.py", lines: [4, 4] }] }, diff)).toEqual([]);
    expect(labelProblems({ ...labelled, evidence: [{ file: "a.py", lines: [9, 9] }] }, diff).join("\n")).toMatch(/changed lines/);
  });

  it("refuses the deletion tag on a bug whose lines replace code, and takes it where code was removed with nothing in its place", () => {
    expect(labelProblems({ ...labelled, tags: ["deletion"] }, shape({ "a.py": [2, 3] })).join("\n")).toMatch(/deletion/);
    expect(labelProblems({ ...labelled, tags: ["deletion"] }, shape({ "a.py": [2, 3] }, { "b.py": [2] })).join("\n")).toMatch(/deletion/);
    expect(labelProblems({ ...labelled, tags: ["deletion"] }, shape({ "a.py": [3, 4] }, { "a.py": [3] }))).toEqual([]);
  });
});
