// Failure list, written before implementation:
// 1. A changed case hash, case file or split keeps a frozen comparison valid.
// 2. A changed build commit, tree, bundle or version keeps acceptance valid.
// 3. A changed board judge, prompt, metric or profile keeps acceptance valid.
// 4. The acceptance hash leaves out a field, including the signer or date.
// 5. Empty acceptance is mistaken for a person's acceptance.
// 6. A named run or calibration file is missing, changed or from another build.
// 7. Missing or malformed record fields pass validation.
// 8. A vendor row lacks provenance, dataset identity or a measurement field.
// 9. Duplicate vendor rows or invalid numbers and dates pass validation.
// 10. Complete vendor rows cannot be validated and printed by the real command.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, caseHash } from "../lib/cases.mjs";
import { comparisonHash, freezeComparison, validateComparison, validateOutsideRows } from "../lib/comparison.mjs";
import { sha256 } from "../lib/index.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const reviewers = { library: { path: "server", reviewer: "model:gpt-6.1-sol", model: "gpt-6.1-sol", graph: "on", web: "off" } };
function fixture() {
  const root = join(tempDir("oq-comparison-"), "benchmark");
  for (const file of ["outside/boards.json", "suites/aacr/cases.json", "splits/aacr-v1.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(benchRoot, file), join(root, file));
  }
  const build = { commit: "a".repeat(40), tree: "b".repeat(40), bundleHash: "c".repeat(64), version: "0.12.0" };
  write(join(root, ".build/provenance.json"), { ...build, cliVersion: build.version });
  const options = { root, build };
  const record = freezeComparison({ release: "compare-2026-10", suites: ["aacr"], boards: ["aacr"], reviewers, capUsd: 100 }, options);
  return { root, build, options, record };
}
const sign = (record) => { record.acceptance = { person: "Sid", date: "2026-10-14", hash: "" }; record.acceptance.hash = comparisonHash(record); return record; };

describe("frozen comparisons", () => {
  it("refuses edited planted case bytes even when the lock was not updated", () => {
    const { root, options } = fixture();
    const name = "clean-python-feature";
    cpSync(join(benchRoot, "cases", name), join(root, "cases", name), { recursive: true });
    write(join(root, "cases.lock.json"), { version: 1, cases: { [name]: { hash: caseHash(name, join(root, "cases")), frozenAt: "2026-10-14", history: null, retired: false } } });
    const record = freezeComparison({ release: "compare-2026-10", suites: ["planted"], boards: ["aacr"], reviewers, capUsd: 100 }, options);
    sign(record);
    const file = join(root, "cases", name, "case.json"); writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
    expect(() => validateComparison(record, options)).toThrow(/case|hash/);
  });
  it("refuses a changed case hash and a changed split", () => {
    for (const file of ["suites/aacr/cases.json", "splits/aacr-v1.json"]) {
      const { root, options, record } = fixture(); sign(record);
      const data = read(join(root, file));
      if (data.cases instanceof Array) data.cases[0].hash = "d".repeat(64);
      else data.salt = "changed";
      write(join(root, file), data);
      expect(() => validateComparison(record, options)).toThrow(/suite|hash|split/);
    }
  });
  for (const field of ["commit", "tree", "bundleHash", "version"]) it(`refuses a changed build ${field}`, () => {
    const { options, record } = fixture(); sign(record);
    expect(() => validateComparison(record, { ...options, build: { ...options.build, [field]: field === "version" ? "0.13.0" : "d".repeat(field === "bundleHash" ? 64 : 40) } })).toThrow(/build/);
  });
  it("refuses changed board judge and prompt pins", () => {
    const { root, options, record } = fixture(); sign(record);
    const boards = read(join(root, "outside/boards.json")); boards.deployments.judge.served = "another-model";
    write(join(root, "outside/boards.json"), boards);
    expect(() => validateComparison(record, options)).toThrow(/board|judge/);
    for (const field of ["promptHash", "metric", "profile"]) {
      const f = fixture(); f.record.boards.aacr[field] = "changed";
      expect(() => validateComparison(f.record, f.options)).toThrow(/board/);
    }
  });
  it("hashes every field including acceptance identity, date and unknown future fields", () => {
    const { options, record } = fixture(); sign(record);
    expect(validateComparison(record, options).accepted).toBe(true);
    function leaves(value, path = []) {
      return value && typeof value === "object" ? Object.entries(value).flatMap(([key, v]) => leaves(v, [...path, key])) : [path];
    }
    for (const path of leaves(record).filter((p) => p.join(".") !== "acceptance.hash")) {
      const changed = structuredClone(record); let target = changed;
      for (const key of path.slice(0, -1)) target = target[key];
      const key = path.at(-1); target[key] = `${target[key]} changed`;
      expect(comparisonHash(changed), path.join(".")).not.toBe(record.acceptance.hash);
      expect(() => validateComparison(changed, options)).toThrow();
    }
    const changed = { ...record, future: "covered" };
    expect(() => validateComparison(changed, options)).toThrow(/acceptance/);
  });
  it("treats empty acceptance as not accepted and refuses partial acceptance", () => {
    const { options, record } = fixture();
    expect(validateComparison(record, options).accepted).toBe(false);
    record.acceptance.person = "Sid";
    expect(() => validateComparison(record, options)).toThrow(/acceptance/);
  });
  it("refuses missing and changed calibration files", () => {
    const { root, options, record } = fixture();
    record.calibrations = [{ file: "index/calibration/check.json", sha256: sha256("{}\n"), agreement: { exact: 0.8, withinOne: 1 } }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    const path = join(root, record.calibrations[0].file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "{}\n"); sign(record);
    expect(validateComparison(record, options).accepted).toBe(true);
    writeFileSync(path, "{\"changed\":true}\n");
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
  });
  it("refuses reference paths outside the benchmark folder", () => {
    const { options, record } = fixture();
    record.calibrations = [{ file: "../package.json", sha256: "a".repeat(64), agreement: { exact: 1 } }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    record.calibrations = []; record.runs = [{ runId: "../outside", sha256: "a".repeat(64), reviewer: "library" }];
    expect(() => validateComparison(record, options)).toThrow(/run/);
  });
  it("refuses missing runs, edited runs and runs from another build", () => {
    const { root, build, options, record } = fixture();
    const entry = read(join(benchRoot, "index/runs/2026-10-12-b43b25b-aacr-gpt61.json"));
    entry.build = { ...entry.build, ...build, short: build.commit.slice(0, 7), cliVersion: build.version };
    record.runs = [{ runId: entry.runId, sha256: sha256(JSON.stringify(entry)), reviewer: "library" }];
    expect(() => validateComparison(record, options)).toThrow(/run/);
    const path = join(root, "index/runs", `${entry.runId}.json`); writeFileSyncAfterMkdir(path, JSON.stringify(entry));
    expect(validateComparison(record, options).accepted).toBe(false);
    entry.scores.changed = {}; writeFileSyncAfterMkdir(path, JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/run/);
    delete entry.scores.changed;
    entry.build.bundleHash = "d".repeat(64); writeFileSyncAfterMkdir(path, JSON.stringify(entry)); record.runs[0].sha256 = sha256(JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/build/);
  });
  for (const field of ["release", "boards", "suites", "build", "reviewers", "capUsd", "runs", "calibrations", "acceptance"]) it(`refuses missing ${field}`, () => {
    const { options, record } = fixture(); delete record[field];
    expect(() => validateComparison(record, options)).toThrow();
  });
});
function writeFileSyncAfterMkdir(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }

describe("pinned vendor rows", () => {
  const data = () => read(join(benchRoot, "index/outside-rows.json"));
  for (const field of ["board", "product", "metric", "value", "measuredBy", "measurementDate", "source", "readDate", "goldenSet"]) it(`refuses a vendor row without ${field}`, () => {
    const rows = data(); delete rows.rows[0][field];
    expect(() => validateOutsideRows(rows)).toThrow(new RegExp(field));
  });
  it("refuses duplicate rows, invalid measurements and impossible dates", () => {
    const rows = data(); rows.rows.push(structuredClone(rows.rows[0])); expect(() => validateOutsideRows(rows)).toThrow(/duplicate/);
    for (const change of [{ value: -1 }, { value: null }, { source: "no URL" }, { measurementDate: "2025-02-30" }, { goldenSet: {} }]) {
      const rows = data(); Object.assign(rows.rows[0], change); expect(() => validateOutsideRows(rows)).toThrow();
    }
  });
  it("prints every complete pinned row through the real validator command", () => {
    const rows = data(); expect(validateOutsideRows(rows)).toEqual(rows.rows);
    const r = spawnSync(process.execPath, [join(benchRoot, "lib/comparison.mjs"), "--outside-rows", join(benchRoot, "index/outside-rows.json")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual(rows.rows);
  });
});
