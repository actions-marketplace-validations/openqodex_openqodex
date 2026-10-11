// The planted cases are frozen: a case keeps one id for one set of bytes, so
// two runs that name the same id reviewed the same code against the same
// truth. Two failures are guarded here:
//
// 1. A case edited after a run keeps its id, so old and new runs compare
//    across different code. Rule F1: every case folder hashes to its lock
//    entry. Rule F2: every case id a run index entry names (legacy entries
//    aside) resolves to a lock entry with that hash.
// 2. A planted bug without a class, or with a class outside the list, is
//    accepted, so the scanner tables group truth by a label nobody chose.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NEW_CASE, caseHash, caseId, casesRoot, indexProblems, listCases, lockProblems, lockRefusals, readCase, readLock, specProblems } from "../lib/cases.mjs";
import { CLASSES, CLASSES_VERSION } from "../lib/classes.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const lock = readLock();
const ids = listCases();

// A copy of one self-contained case in a temp cases folder, with a lock
// that froze it as it is.
function frozenCopy(name) {
  const root = join(tempDir("oq-bench-freeze-"), "cases");
  mkdirSync(root);
  cpSync(join(casesRoot, name), join(root, name), { recursive: true });
  const copyLock = { version: 1, cases: { [name]: { hash: caseHash(name, root), frozenAt: "2026-10-10", history: null, retired: false } } };
  return { root, copyLock };
}

function indexFolder(entries) {
  const dir = join(tempDir("oq-bench-index-"), "runs");
  mkdirSync(dir);
  for (const [file, entry] of Object.entries(entries)) writeFileSync(join(dir, file), JSON.stringify(entry));
  return dir;
}

describe("the case lock (a case edited after a run keeps its id, so old and new runs compare across different code)", () => {
  it("F1: every case folder hashes to its lock entry, and the lock names no case without a folder", () => {
    expect(lockProblems(lock)).toEqual([]);
    expect(Object.keys(lock.cases).sort()).toEqual(ids);
  });

  it("F1: one byte edited in a frozen case is a spec edit after a run, which is a new case", () => {
    const { root, copyLock } = frozenCopy("clean-python-feature");
    expect(lockProblems(copyLock, root)).toEqual([]);
    const spec = join(root, "clean-python-feature", "case.json");
    writeFileSync(spec, readFileSync(spec, "utf8").replace('"guards": "a', '"guards": "A'));
    const problems = lockProblems(copyLock, root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(NEW_CASE);
    expect(NEW_CASE).toBe("a spec edit after a run is a new case");
  });

  it("gives every case the id planted/<name>@<first 8 hex of its hash>", () => {
    for (const name of ids) expect(caseId(name)).toBe(`planted/${name}@${lock.cases[name].hash.slice(0, 8)}`);
  });

  it("F2: every case id a run index entry names resolves to a lock entry with that hash", () => {
    expect(indexProblems(lock)).toEqual([]);
  });

  it("F2: an index entry naming a case id the lock no longer holds fails, and a legacy entry is not held to the lock", () => {
    const name = "clean-python-feature";
    const current = `planted/${name}@${lock.cases[name].hash.slice(0, 8)}`;
    const stale = `planted/${name}@00000000`;
    expect(indexProblems(lock, indexFolder({ "a.json": { runId: "a", caseIds: [current] } }))).toEqual([]);
    const problems = indexProblems(lock, indexFolder({ "b.json": { runId: "b", caseIds: [current, stale] } }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(stale);
    expect(problems[0]).toContain(NEW_CASE);
    expect(indexProblems(lock, indexFolder({ "c.json": { runId: "c", legacy: true, caseIds: [stale] } }))).toEqual([]);
    expect(indexProblems(lock, indexFolder({ "d.json": { runId: "d", caseIds: ["planted/no-such-case@12345678"] } })).join("\n")).toMatch(/no-such-case/);
    expect(indexProblems(lock, indexFolder({ "e.json": { runId: "e" } })).join("\n")).toMatch(/caseIds/);
  });

  it("refuses to run a case its lock entry does not match unless it is a draft, and a retired case unless retired cases are allowed", () => {
    const { root, copyLock } = frozenCopy("clean-python-feature");
    const names = ["clean-python-feature"];
    expect(lockRefusals(names, copyLock, {}, root)).toEqual([]);
    const spec = join(root, "clean-python-feature", "case.json");
    writeFileSync(spec, readFileSync(spec, "utf8").replace('"guards": "a', '"guards": "A'));
    expect(lockRefusals(names, copyLock, {}, root).join("\n")).toContain(NEW_CASE);
    expect(lockRefusals(names, copyLock, { draft: true }, root)).toEqual([]);
    expect(lockRefusals(names, { version: 1, cases: {} }, {}, root).join("\n")).toMatch(/no lock entry/);
    expect(lockRefusals(names, { version: 1, cases: {} }, { draft: true }, root)).toEqual([]);
    const retired = { version: 1, cases: { "clean-python-feature": { ...copyLock.cases["clean-python-feature"], hash: caseHash("clean-python-feature", root), retired: true } } };
    expect(lockRefusals(names, retired, {}, root).join("\n")).toMatch(/retired/);
    expect(lockRefusals(names, retired, { allowRetired: true }, root)).toEqual([]);
  });
});

describe("bug labels (a planted bug without a class, or with a class outside the list, is accepted)", () => {
  const base = { id: "x", guards: "g", language: "python", framework: "none", clean: false };
  const sound = { id: "b", file: "a.py", lines: [1, 3], anchor: { line: 1, text: "x" }, mentions: ["injection"], kind: ["security"], class: "sql-injection", tags: [], evidence: [], severity: "major", found_by: ["reasoning"], truth: "t" };
  const problems = (bug) => specProblems({ ...base, bugs: [bug] }, "x").join("\n");

  it("has the 32 classes of the scanner part, with a list version", () => {
    expect(CLASSES).toHaveLength(32);
    expect(new Set(CLASSES).size).toBe(32);
    expect(CLASSES_VERSION).toBe(1);
  });

  it("refuses a bug without a class, with a class outside the list, with an unknown tag or with malformed evidence", () => {
    expect(problems(sound)).toBe("");
    expect(problems({ ...sound, class: undefined })).toMatch(/class/);
    expect(problems({ ...sound, class: "injection" })).toMatch(/class/);
    expect(problems({ ...sound, tags: undefined })).toMatch(/tags/);
    expect(problems({ ...sound, tags: ["callers"] })).toMatch(/tags/);
    expect(problems({ ...sound, tags: ["deletion", "deletion"] })).toMatch(/tags/);
    expect(problems({ ...sound, evidence: undefined })).toMatch(/evidence/);
    expect(problems({ ...sound, evidence: [{ file: "b.py", lines: [4, 2] }] })).toMatch(/evidence/);
    expect(problems({ ...sound, tags: ["needs-callers"] })).toMatch(/needs-callers/);
    expect(problems({ ...sound, tags: ["needs-callers"], evidence: [{ file: "b.py", lines: [2, 4] }] })).toBe("");
  });

  it("gives every planted bug in the corpus a class from the list, its tags and its evidence", () => {
    for (const id of ids) {
      for (const b of readCase(id).bugs) {
        expect(CLASSES, `${id}/${b.id}`).toContain(b.class);
        expect(Array.isArray(b.tags) && Array.isArray(b.evidence), `${id}/${b.id}`).toBe(true);
      }
    }
  });
});
