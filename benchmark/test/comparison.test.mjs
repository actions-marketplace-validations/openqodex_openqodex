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
// 11. A name outside people.json or a model accepts a signed comparison.
// 12. Missing effort or output-token pins, or different manifest settings, match.
// 13. A local manifest supplies a build tree without a verified run folder.
// 14. A vendor page snapshot is missing or its bytes differ from the row's hash.
// 15. Calibration build identity or agreement differs from the reference.
// 16. Calibration agreement is below 90 percent on either class without a ruling.
// 17. A matching person's ruling cannot admit a calibration below the bar.
// 18. A ruling's percentages differ from the saved calibration.
// 19. A ruling names someone missing from people.json, or no person at all.
// 20. A ruling names a board without a calibration record.
// 21. Page data loses per-class agreement or requires a ruling above the bar.
// 22. Two calibration files for one board overwrite its agreement.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, caseHash } from "../lib/cases.mjs";
import { comparisonHash, freezeComparison, validateComparison, validateOutsideRows } from "../lib/comparison.mjs";
import { hashFolder, sha256 } from "../lib/index.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const reviewers = { library: { path: "server", reviewer: "model:gpt-6.1-sol", model: "gpt-6.1-sol", graph: "on", web: "off", effort: "high", maxOutputTokens: 32000 } };
function fixture() {
  const root = join(tempDir("oq-comparison-"), "benchmark");
  for (const file of ["outside/boards.json", "suites/aacr/cases.json", "splits/aacr-v1.json", "review-queue/people.json"]) {
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
function calibrationFixture(f) {
  const calibration = { version: 1, board: f.record.boards.aacr, vendor: "fixture", labelUnit: "golden comment", judgeModel: f.record.boards.aacr.judgeModel, promptHash: f.record.boards.aacr.promptHash, costUsd: 0, build: { ...f.build }, agreement: { positive: 1, negative: 1 }, counts: { total: 20, agree: 20, disagree: 0, byClass: { positive: { total: 10, agree: 10, disagree: 0 }, negative: { total: 10, agree: 10, disagree: 0 } } } };
  const file = "index/calibration/check.json";
  write(join(f.root, file), calibration);
  f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), ...structuredClone(calibration) }];
  return calibration;
}
function ruledCalibrationFixture() {
  const f = fixture();
  const calibration = read(join(benchRoot, "index/calibration/greptile-2026-10-21.json"));
  calibration.build = { ...f.build };
  f.record.boards.greptile = calibration.board;
  const file = "index/calibration/greptile.json";
  write(join(f.root, file), calibration);
  f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), build: calibration.build, agreement: calibration.agreement }];
  f.record.calibrationRulings = [{ board: "greptile", decidedBy: "Sid", decidedOn: "2026-10-22", agreement: { caught: 85.37, missed: 88.89 } }];
  return f;
}
function runFixture(f, tree = true, list = "private") {
  const entry = read(join(benchRoot, "index/runs/2026-10-12-b43b25b-aacr-gpt61.json"));
  entry.build = { ...entry.build, ...f.build, short: f.build.commit.slice(0, 7), cliVersion: f.build.version };
  if (!tree) delete entry.build.tree;
  const folder = join(f.root, "results", entry.runId);
  const manifest = { build: { ...f.build }, reviewers: { "model:gpt-6.1-sol": { ...entry.reviewers["model:gpt-6.1-sol"], settings: { effort: "high", maxOutputTokens: 32000 } } } };
  const save = () => {
    write(join(folder, "manifest.json"), manifest);
    if (list === "private") entry.privateListHash = hashFolder(folder).listHash;
    else entry.asset.listHash = hashFolder(folder).listHash;
    write(join(f.root, "index/runs", `${entry.runId}.json`), entry);
    f.record.runs = [{ runId: entry.runId, sha256: sha256(readFileSync(join(f.root, "index/runs", `${entry.runId}.json`))), reviewer: "library" }];
  };
  save();
  return { entry, manifest, folder, save };
}

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
  for (const person of ["Unlisted person", "Codex"]) it(`refuses acceptance by ${person.toLowerCase()}`, () => {
    const { options, record } = fixture(); sign(record);
    record.acceptance.person = person; record.acceptance.hash = comparisonHash(record);
    expect(() => validateComparison(record, options)).toThrow(/person|acceptance/);
  });
  for (const field of ["effort", "maxOutputTokens"]) {
    it(`refuses a reviewer without a ${field} pin`, () => {
      const { options, record } = fixture(); record.reviewers = structuredClone(reviewers); delete record.reviewers.library[field];
      expect(() => validateComparison(record, options)).toThrow(/reviewer/);
    });
    it(`refuses a run with different ${field}`, () => {
      const f = fixture(); const run = runFixture(f);
      expect(validateComparison(f.record, f.options).accepted).toBe(false);
      run.manifest.reviewers["model:gpt-6.1-sol"].settings[field] = field === "effort" ? "low" : 16000; run.save();
      expect(() => validateComparison(f.record, f.options)).toThrow(/reviewer settings/);
    });
  }
  for (const list of ["asset", "private"]) it(`refuses an edited legacy manifest after verifying the ${list} list hash`, () => {
    const f = fixture(); const run = runFixture(f, false, list);
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    write(join(run.folder, "manifest.json"), { ...run.manifest, edited: true });
    expect(() => validateComparison(f.record, f.options)).toThrow(/list hash/);
  });
  it("refuses a legacy tree changed locally to match the comparison", () => {
    const f = fixture(); const run = runFixture(f, false);
    run.manifest.build.tree = "d".repeat(40); run.save();
    expect(() => validateComparison(f.record, f.options)).toThrow(/build/);
    run.manifest.build.tree = f.build.tree; write(join(run.folder, "manifest.json"), run.manifest);
    expect(() => validateComparison(f.record, f.options)).toThrow(/list hash/);
  });
  it("refuses missing and changed calibration files", () => {
    const f = fixture(); const { root, options, record } = f;
    const calibration = calibrationFixture(f);
    const bytes = `${JSON.stringify(calibration, null, 2)}\n`;
    record.calibrations = [{ file: "index/calibration/missing.json", sha256: sha256(bytes), ...calibration }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    const path = join(root, record.calibrations[0].file); writeFileSyncAfterMkdir(path, bytes); sign(record);
    expect(validateComparison(record, options).accepted).toBe(true);
    writeFileSync(path, "{\"changed\":true}\n");
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
  });
  it("refuses a calibration reference from another build", () => {
    const f = fixture(); calibrationFixture(f);
    f.record.calibrations[0].build.tree = "d".repeat(40);
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*build/);
  });
  it("refuses two calibration files for the same board", () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    const file = "index/calibration/duplicate-board.json";
    write(join(f.root, file), calibration);
    f.record.calibrations.push({ ...structuredClone(f.record.calibrations[0]), file });
    expect(() => validateComparison(f.record, f.options)).toThrow("duplicate calibration board aacr");
  });
  it("refuses a calibration file from another build even with its correct hash", () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    expect(validateComparison(f.record, f.options).accepted).toBe(false);
    calibration.build.bundleHash = "d".repeat(64);
    const c = f.record.calibrations[0]; write(join(f.root, c.file), calibration); c.sha256 = sha256(readFileSync(join(f.root, c.file)));
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*build/);
  });
  it("refuses claimed calibration agreement that differs from the saved numbers", () => {
    const f = fixture(); calibrationFixture(f); f.record.calibrations[0].agreement.positive = 0.95;
    expect(() => validateComparison(f.record, f.options)).toThrow(/calibration.*agreement/);
  });
  for (const name of ["positive", "negative"]) it(`refuses a calibration below 90 percent on ${name} without a ruling`, () => {
    const f = fixture(); const calibration = calibrationFixture(f);
    calibration.counts.byClass[name] = { total: 10, agree: 8, disagree: 2 };
    calibration.counts.agree = 18; calibration.counts.disagree = 2; calibration.agreement[name] = 0.8;
    const c = f.record.calibrations[0]; Object.assign(c, structuredClone(calibration));
    write(join(f.root, c.file), calibration); c.sha256 = sha256(readFileSync(join(f.root, c.file)));
    expect(() => validateComparison(f.record, f.options)).toThrow(/90 percent/);
  });
  it("refuses the sub-bar Greptile calibration without a ruling", () => {
    const f = ruledCalibrationFixture(); delete f.record.calibrationRulings;
    expect(() => validateComparison(f.record, f.options)).toThrow(/90 percent/);
  });
  it("accepts the sub-bar calibration with matching ruling percentages and exposes them to the page", () => {
    const f = ruledCalibrationFixture(); sign(f.record);
    const result = validateComparison(f.record, f.options);
    expect(result.accepted).toBe(true);
    expect(result.boards.greptile.judgeAgreement).toEqual({ caught: 85.37, missed: 88.89 });
    expect(result.boards.aacr.judgeAgreement).toBeNull();
  });
  for (const name of ["caught", "missed"]) it(`refuses a ruling whose ${name} percentage differs from the calibration record`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].agreement[name] += 0.01;
    sign(f.record);
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*agreement/);
  });
  for (const name of ["Unlisted person", "", "Codex"]) it(`refuses a calibration ruling by ${name || "a missing person"}`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].decidedBy = name;
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*person/);
  });
  for (const board of ["aacr", "unknown"]) it(`refuses a ruling for ${board} without a calibration record`, () => {
    const f = ruledCalibrationFixture(); f.record.calibrationRulings[0].board = board;
    f.record.calibrations = [];
    expect(() => validateComparison(f.record, f.options)).toThrow(/ruling.*calibration record/);
  });
  it("accepts the saved Martian calibration with one excluded deduplication item and exposes both agreement classes", () => {
    const f = fixture();
    const calibration = read(join(benchRoot, "index/calibration/martian-2026-10-21.json"));
    expect(calibration.status).toBe("complete");
    expect(calibration.excluded).toEqual({ count: 1, reason: expect.stringMatching(/deduplication.*three invalid.*two.*labels/i) });
    expect(calibration.judgeFailures).toMatchObject({ items: 1, labels: 2 });
    calibration.build = { ...f.build };
    f.record.boards.martian = calibration.board;
    const file = "index/calibration/martian.json";
    write(join(f.root, file), calibration);
    f.record.calibrations = [{ file, sha256: sha256(readFileSync(join(f.root, file))), build: calibration.build, agreement: calibration.agreement }];
    sign(f.record);
    const result = validateComparison(f.record, f.options);
    expect(result.accepted).toBe(true);
    expect(result.boards.martian.judgeAgreement).toEqual({ positive: 92.45, negative: 96.92 });
  });
  it("refuses reference paths outside the benchmark folder", () => {
    const { options, record } = fixture();
    record.calibrations = [{ file: "../package.json", sha256: "a".repeat(64), build: record.build, agreement: { exact: 1 } }];
    expect(() => validateComparison(record, options)).toThrow(/calibration/);
    record.calibrations = []; record.runs = [{ runId: "../outside", sha256: "a".repeat(64), reviewer: "library" }];
    expect(() => validateComparison(record, options)).toThrow(/run/);
  });
  it("refuses missing runs, edited runs and runs from another build", () => {
    const f = fixture(); const { root, options, record } = f;
    const { entry } = runFixture(f);
    entry.runId = "2026-10-12-comparison-missing";
    record.runs[0].runId = entry.runId; record.runs[0].sha256 = sha256(JSON.stringify(entry));
    expect(() => validateComparison(record, options)).toThrow(/run/);
    entry.runId = "2026-10-12-b43b25b-aacr-gpt61"; record.runs[0].runId = entry.runId; record.runs[0].sha256 = sha256(JSON.stringify(entry));
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
  for (const board of ["greptile-original", "augment-corrected"]) {
    it(`refuses ${board} without a source snapshot`, () => {
      const rows = data(); rows.rows = rows.rows.filter((r) => r.board === board); delete rows.rows[0].snapshot;
      expect(() => validateOutsideRows(rows)).toThrow(/snapshot/);
    });
    it(`refuses ${board} when the snapshot bytes change`, () => {
      const root = join(tempDir("oq-outside-snapshot-"), "benchmark");
      const rows = data(); rows.rows = [rows.rows.find((r) => r.board === board)];
      const file = `index/outside-sources/${board}.txt`; const path = join(root, file);
      writeFileSyncAfterMkdir(path, "Saved page\n"); rows.rows[0].snapshot = { file, sha256: sha256(readFileSync(path)) };
      expect(validateOutsideRows(rows, { root })).toEqual(rows.rows);
      writeFileSync(path, "Edited page\n");
      expect(() => validateOutsideRows(rows, { root })).toThrow(/snapshot.*hash/);
    });
  }
  it("prints every complete pinned row through the real validator command", () => {
    const rows = data(); expect(validateOutsideRows(rows)).toEqual(rows.rows);
    const r = spawnSync(process.execPath, [join(benchRoot, "lib/comparison.mjs"), "--outside-rows", join(benchRoot, "index/outside-rows.json")], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0); expect(JSON.parse(r.stdout)).toEqual(rows.rows);
  });
});
