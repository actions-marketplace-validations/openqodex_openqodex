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
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NEW_CASE, buildCase, caseHash, caseId, caseIdFromHash, casesRoot, indexProblems, listCases, loadRunLock, lockProblems, lockRefusals, readCase, readLock, snapshotCases, specProblems } from "../lib/cases.mjs";
import { CLASSES, CLASSES_VERSION } from "../lib/classes.mjs";
import { readRunManifests, updateLock } from "../lib/lock.mjs";
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

// One byte of the spec changed, the way a hand edit would.
function editSpec(root, name) {
  const spec = join(root, name, "case.json");
  writeFileSync(spec, readFileSync(spec, "utf8").replace('"guards": "a', '"guards": "A'));
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

  it("gives an edited case a new id, which the lock it was frozen in refuses", () => {
    const name = "clean-python-feature";
    const { root, copyLock } = frozenCopy(name);
    const before = caseId(name, root);
    expect(before).toBe(caseIdFromHash(name, copyLock.cases[name].hash));
    editSpec(root, name);
    const after = caseId(name, root);
    expect(after).toMatch(/^planted\/clean-python-feature@[0-9a-f]{8}$/);
    expect(after).not.toBe(before);
    expect(lockRefusals([name], copyLock, {}, root).join("\n")).toContain(NEW_CASE);
  });

  it("refuses a symbolic link in a case, which the build would copy but the hash would skip", () => {
    const name = "clean-python-feature";
    const { root } = frozenCopy(name);
    symlinkSync("../../base/ledger/money.py", join(root, name, "change", "ledger", "linked.py"));
    expect(() => caseHash(name, root)).toThrow(/symbolic link/);
  });

  it("hashes each file's executable mode, which the build and the diff keep", () => {
    const name = "clean-python-feature";
    const { root, copyLock } = frozenCopy(name);
    const file = join(root, name, "change", "ledger", "money.py");
    chmodSync(file, statSync(file).mode | 0o111);
    expect(caseHash(name, root)).not.toBe(copyLock.cases[name].hash);
  });

  it("builds every attempt from a snapshot taken at run start, so an edit of the live folders while a run goes reaches no attempt", () => {
    const name = "clean-python-feature";
    const { root, copyLock } = frozenCopy(name);
    const snap = snapshotCases([name], join(tempDir("oq-bench-snap-"), "copy"), { root, anchor: dirname(root) });
    editSpec(root, name);
    writeFileSync(join(root, name, "change", "ledger", "money.py"), "edited while the run goes\n");
    expect(caseHash(name, snap)).toBe(copyLock.cases[name].hash);
    const { dir, spec } = buildCase(name, join(tempDir("oq-bench-snap-build-"), "repo"), snap);
    expect(spec.guards.startsWith("a ")).toBe(true);
    expect(readFileSync(join(dir, "ledger", "money.py"), "utf8")).not.toBe("edited while the run goes\n");
  });

  it("snapshots the demo's base and change, which lie outside its case folder", () => {
    const into = join(tempDir("oq-bench-snap-demo-"), "copy");
    const snap = snapshotCases(["demo-polyglot"], into);
    expect(existsSync(join(into, "examples", "demo-repo", "planted", "scripts", "deploy.sh"))).toBe(true);
    expect(caseHash("demo-polyglot", snap)).toBe(lock.cases["demo-polyglot"].hash);
  });

  it("refuses a lock that is there but unsound, even for a draft run, so a draft cannot skip a retirement", () => {
    const dir = tempDir("oq-bench-runlock-");
    const bad = join(dir, "cases.lock.json");
    writeFileSync(bad, JSON.stringify({ version: 1, cases: { x: { hash: "zz", retired: true } } }));
    expect(() => loadRunLock(bad, { draft: true })).toThrow(/not sound/);
    expect(() => loadRunLock(bad, { draft: false })).toThrow(/not sound/);
    const missing = join(dir, "missing.json");
    expect(loadRunLock(missing, { draft: true })).toEqual({ version: 1, cases: {} });
    expect(() => loadRunLock(missing, { draft: false })).toThrow(/draft/);
  });

  it("refuses to rewrite the lock entry of a case a local run used, unless forced with a reason that goes into its history", () => {
    const name = "clean-python-feature";
    const { root, copyLock } = frozenCopy(name);
    const frozen = copyLock.cases[name].hash;
    const results = join(tempDir("oq-bench-results-"), "results");
    mkdirSync(join(results, "2026-10-12-abc1234"), { recursive: true });
    writeFileSync(join(results, "2026-10-12-abc1234", "manifest.json"), JSON.stringify({ started_at: "2026-10-12T00:00:00.000Z", cases: [name], caseHashes: { [name]: frozen } }));
    const store = join(tempDir("oq-bench-store-"), "runs");
    mkdirSync(store);
    const runs = readRunManifests([results, store]);
    expect(runs.map((r) => r.run)).toEqual(["2026-10-12-abc1234"]);
    editSpec(root, name);
    const noIndex = join(tempDir("oq-bench-noindex-"), "runs");
    const refused = updateLock(structuredClone(copyLock), { root, runs, indexDir: noIndex, today: "2026-10-12" });
    expect(refused.refusals.join("\n")).toContain(name);
    expect(refused.refusals.join("\n")).toContain(NEW_CASE);
    const forced = updateLock(structuredClone(copyLock), { root, runs, indexDir: noIndex, today: "2026-10-12", force: "the reason given" });
    expect(forced.refusals).toEqual([]);
    expect(forced.lock.cases[name].hash).toBe(caseHash(name, root));
    expect(forced.lock.cases[name].history).toContain("the reason given");
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
