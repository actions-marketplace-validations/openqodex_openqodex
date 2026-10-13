// Failure list, written before the submission code:
// 1. A missing metadata, result or offline file passes --check.
// 2. Missing or wrongly typed sample fields pass --check.
// 3. Repeats overwrite each other, findings vanish, or provenance names this checkout.
// 4. A malformed real run silently falls back to fixtures.
// 5. A second export overwrites a prepared folder.
// 6. An unverified licence or a mock judge is presented as a board run.
// 7. Martian candidates and evaluations name reviews absent from the input.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";
import { benchRoot, git, repoRoot } from "../lib/cases.mjs";

afterAll(removeTempDirs);
const fixtures = join(benchRoot, "outside/fixtures/martian");
// The accepted run lives in the main checkout's benchmark/results, which git
// ignores; a linked worktree finds it through git's common folder.
const mainCheckout = resolve(git(repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(), "..");
const accepted = process.env.OPENQODEX_AACR_SUBMIT_RUN ?? join(mainCheckout, "benchmark/results/2026-10-12-b43b25b-aacr-gpt61");
const cli = (board, ...args) => spawnSync(process.execPath, [join(benchRoot, `outside/submit/${board}.mjs`), ...args], { encoding: "utf8" });
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const output = () => join(tempDir("oq-board-submit-"), "submission");
const martian = () => {
  const out = output();
  const r = cli("martian", fixtures, "--out", out);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("fixtures");
  return out;
};

it.each(["benchmark_data.json", "gpt-5.2/candidates.json", "gpt-5.2/evaluations.json", "gpt-5.2/dedup_groups.json", "submission.json"])("Missing Martian file %s fails check", (file) => {
  const out = martian();
  rmSync(join(out, file));
  expect(cli("martian", "--check", out).status).toBe(2);
});
it("Saved Martian converter fixtures pass check with fixture provenance", () => {
  const out = martian();
  expect(cli("martian", "--check", out).status).toBe(0);
  expect(json(join(out, "submission.json"))).toMatchObject({ name: "OpenQodex", source: "fixtures", judge_mode: "stand-in" });
  expect(json(join(out, "benchmark_data.json"))).toEqual(json(join(fixtures, "benchmark_data.json")));
});
it("Wrongly typed Martian candidates fail check", () => {
  const out = martian();
  const p = join(out, "gpt-5.2/candidates.json");
  const data = json(p);
  Object.values(Object.values(data)[0])[0][0].text = 42;
  writeFileSync(p, JSON.stringify(data));
  expect(cli("martian", "--check", out).status).toBe(2);
});
it("Martian evaluations for absent reviews fail check", () => {
  const out = martian();
  const p = join(out, "gpt-5.2/evaluations.json");
  const data = json(p);
  data["unknown"] = Object.values(data)[0];
  writeFileSync(p, JSON.stringify(data));
  expect(cli("martian", "--check", out).status).toBe(2);
});
it("A missing real Martian run does not fall back to fixtures", () => {
  expect(cli("martian", join(tempDir("oq-board-submit-"), "missing"), "--out", output()).status).toBe(2);
});
it("A second export refuses an existing output", () => {
  const out = martian();
  expect(cli("martian", fixtures, "--out", out).status).toBe(2);
});

it.skipIf(!existsSync(accepted))("Accepted AACR run preserves all repeats and manifest metadata", () => {
  const out = output();
  const r = cli("aacr", accepted, "--out", out);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  expect(cli("aacr", "--check", out).status).toBe(0);
  const manifest = json(join(accepted, "manifest.json"));
  const record = json(join(accepted, "outside/aacr/convert.json"));
  const index = json(join(out, "submission.json"));
  expect(index).toMatchObject({ name: "OpenQodex", commit: manifest.build.commit, version: manifest.build.cliVersion, run: manifest.runId });
  expect(index.submissions).toHaveLength(record.folders.length);
  for (const entry of index.submissions) {
    const meta = readFileSync(join(out, entry.dir, "meta.yaml"), "utf8");
    expect(meta).toContain('submission_name: "OpenQodex"');
    expect(meta).toContain(`commit: "${manifest.build.commit}"`);
    expect(entry.instances).toHaveLength(record.instances.length);
    for (const instance of record.instances) {
      const written = json(join(out, entry.dir, "results", `${instance.instanceId}.json`));
      const source = json(join(accepted, "outside/aacr", entry.config, `r${entry.repeat}`, `${instance.instanceId}.json`));
      expect(written.review.comments).toEqual(source.review.comments.map((c) => ({ ...c, side: "right" })));
    }
  }
});
it.skipIf(!existsSync(accepted)).each(["meta.yaml", "result"])("Missing AACR %s fails check", (file) => {
  const out = output();
  expect(cli("aacr", accepted, "--out", out).status).toBe(0);
  const entry = json(join(out, "submission.json")).submissions[0];
  rmSync(join(out, entry.dir, file === "result" ? `results/${entry.instances[0]}.json` : file));
  expect(cli("aacr", "--check", out).status).toBe(2);
});
it.skipIf(!existsSync(accepted))("Wrongly typed AACR sample fails check", () => {
  const out = output();
  expect(cli("aacr", accepted, "--out", out).status).toBe(0);
  const entry = json(join(out, "submission.json")).submissions[0];
  const p = join(out, entry.dir, `results/${entry.instances[0]}.json`);
  const data = json(p);
  data.review.summary.total_tokens = "100";
  writeFileSync(p, JSON.stringify(data));
  expect(cli("aacr", "--check", out).status).toBe(2);
});
it.skipIf(!existsSync(accepted))("AACR mock judging refuses export", () => {
  const run = join(tempDir("oq-board-submit-"), "run");
  cpSync(accepted, run, { recursive: true });
  const p = join(run, "outside/aacr/eval.json");
  const data = json(p);
  data.folders[0].mode = "mock";
  writeFileSync(p, JSON.stringify(data));
  expect(cli("aacr", run, "--out", output()).status).toBe(2);
});
it.skipIf(!existsSync(accepted))("AACR unverified licence refuses export", () => {
  const run = join(tempDir("oq-board-submit-"), "run");
  cpSync(accepted, run, { recursive: true });
  const name = json(join(run, "manifest.json")).cases[0];
  const p = join(run, "cases", `${name}.json`);
  const data = json(p);
  data.source.licence.class = "unverified";
  writeFileSync(p, JSON.stringify(data));
  expect(cli("aacr", run, "--out", output()).status).toBe(2);
});
