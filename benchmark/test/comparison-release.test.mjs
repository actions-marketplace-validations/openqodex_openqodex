// Failure list, written before implementation:
// 1. A development run reviews a held-out split.
// 2. An unsigned or uncommitted comparison admits held-out cases.
// 3. A changed build fingerprint or a dirty build or checkout is admitted.
// 4. A release uses a suite or split outside its accepted pins.
// 5. Truth is read before access is logged, or after logging fails.
// 6. A pinned local build is described as an npm package.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { benchRoot, git } from "../lib/cases.mjs";
import { comparisonHash, freezeComparison } from "../lib/comparison.mjs";
import { releaseGate } from "../lib/martian-board.mjs";
import { bundleHash } from "../lib/runner.mjs";
import { selectCases, truthOf } from "../lib/suites.mjs";

const dirs = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
function fixture({ accepted = true, committed = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "oq-comparison-release-")); dirs.push(repo);
  const root = join(repo, "benchmark");
  for (const file of ["outside/boards.json", "suites/aacr/cases.json", "splits/aacr-v1.json", "review-queue/people.json"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(benchRoot, file), join(root, file));
  }
  writeFileSync(join(repo, ".gitignore"), "benchmark/.build/\nbenchmark/index/heldout-access.jsonl\n");
  write(join(repo, "packages/cli/package.json"), { version: "0.12.0" });
  write(join(repo, "packages/cli/dist/bin.js"), "a real bundle fixture");
  git(repo, "init", "-q"); git(repo, "add", ".");
  git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Build fixture");
  const build = { commit: git(repo, "rev-parse", "HEAD").trim(), tree: git(repo, "rev-parse", "HEAD^{tree}").trim(), bundleHash: bundleHash(join(repo, "packages/cli")), version: "0.12.0" };
  write(join(root, ".build/provenance.json"), { ...build, commitTree: build.tree, dirty: false });
  const record = freezeComparison({ release: "test-release", suites: ["aacr"], boards: ["aacr"], reviewers: { control: { path: "laptop", reviewer: "control", model: "claude-opus-5-5", graph: "off", web: "off", effort: null, maxOutputTokens: null } }, capUsd: 1 }, { root, build });
  if (accepted) { record.acceptance = { person: "Sid", date: "2026-10-14", hash: "" }; record.acceptance.hash = comparisonHash(record); }
  const file = join(root, "index/comparisons/test-release.json"); write(file, record);
  if (committed) { git(repo, "add", "."); git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Freeze comparison"); }
  const manifest = { release: record.release, suite: "aacr", split: "test", splitHash: record.suites.aacr.splitHash, build: { ...build, cliVersion: build.version, dirty: false, commitTree: build.tree }, package: { spec: "local", commit: build.commit, dirty: false } };
  const options = { root, suite: "aacr", split: "test", release: record.release, build: manifest.build, packageRecord: manifest.package, runId: "test-run", by: "Sid" };
  return { repo, root, build, record, manifest, options, file, log: join(root, "index/heldout-access.jsonl") };
}

it("refuses a development run on a held-out split", () => {
  expect(() => selectCases({ suite: "aacr", split: "test" })).toThrow(/held out/);
});
it("refuses an unaccepted comparison record", async () => {
  const f = fixture({ accepted: false });
  expect(() => selectCases(f.options)).toThrow(/not accepted/);
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/not accepted/);
  expect(existsSync(f.log)).toBe(false);
});
it("refuses a comparison record that has not been committed", () => {
  const f = fixture({ committed: false });
  expect(() => selectCases(f.options)).toThrow(/committed/);
});
it("refuses a changed build fingerprint", async () => {
  const f = fixture(); f.manifest.build.bundleHash = "d".repeat(64);
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/build/);
});
it("refuses a bundle changed after provenance was written", () => {
  const f = fixture(); write(join(f.repo, "packages/cli/dist/bin.js"), "changed");
  expect(() => selectCases(f.options)).toThrow(/bundle|build/);
});
it("refuses a dirty build", async () => {
  const f = fixture(); f.manifest.build.dirty = true;
  await expect(releaseGate(f.manifest, { root: f.root })).rejects.toThrow(/clean/);
});
it("refuses a dirty checkout", () => {
  const f = fixture(); writeFileSync(join(f.repo, "scratch.txt"), "dirty\n");
  expect(() => selectCases(f.options)).toThrow(/clean|dirty/);
});
it("refuses a suite or split outside the accepted pins", async () => {
  const f = fixture();
  for (const patch of [{ suite: "martian" }, { splitHash: "f".repeat(64) }, { split: "dev" }]) {
    await expect(releaseGate({ ...f.manifest, ...patch }, { root: f.root })).rejects.toThrow(/suite|split/);
  }
});
it("logs accepted pinned access before truth can be read", async () => {
  const f = fixture(); const cases = selectCases(f.options);
  const access = read(f.log);
  expect(access).toMatchObject({ suite: "aacr", purpose: "release-run", release: "test-release", runId: "test-run", caseCount: cases.length, comparisonHash: f.record.acceptance.hash, build: `local build ${f.build.commit}` });
  // No raw truth is installed: the read fails after admission was logged.
  expect(() => truthOf(cases[0], { cache: join(f.repo, "empty-cache") })).toThrow(/not in the cache/);
  const gate = await releaseGate(f.manifest, { root: f.root });
  expect(gate.buildLabel).toBe(`local build ${f.build.commit}`);
  expect(gate.package).toEqual(f.manifest.package);
  expect(gate.package).not.toHaveProperty("name");
  expect(gate.package).not.toHaveProperty("integrity");
});
it("refuses access when its log cannot be written", () => {
  const f = fixture();
  expect(() => selectCases({ ...f.options, accessLog: f.file + "/blocked" })).toThrow(/access log/);
});
