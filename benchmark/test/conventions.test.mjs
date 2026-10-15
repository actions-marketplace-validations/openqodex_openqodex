// Failures guarded: the convention cases enter the frozen corpus, cannot
// materialise in either review shape, or lose their selected rules when
// the laptop runner uses an external report folder. A fixture config must
// also survive git add so a fresh clone reviews the same cases.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { benchRoot, listCases, repoRoot } from "../lib/cases.mjs";
import { laptopReviewArgs } from "../lib/runner.mjs";
import { classify, scoreSample } from "../lib/score.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it.each(["claude", "model:gpt-6.1-sol"])("keeps convention cases separate and builds the review shape for %s", (reviewer) => {
  const out = mkdtempSync(join(tmpdir(), "oq-convention-proof-"));
  roots.push(out);
  const before = readFileSync(join(benchRoot, "cases.lock.json"));
  const run = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--suite", "conventions", "--materialise-only", "--reviewers", reviewer, "--out", out], { cwd: repoRoot, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  const proof = JSON.parse(readFileSync(join(out, "proof.json"), "utf8"));
  expect(proof.suite).toBe("conventions");
  expect(proof.shape).toBe(reviewer.startsWith("model:") ? "server" : "laptop");
  expect(run.stdout).toContain("3 of 3 cases proved");
  for (const name of ["violation", "exception", "no-rule"]) {
    expect(run.stdout).toContain(`conventions/${name}@`);
    expect(listCases()).not.toContain(name);
  }
  expect(readFileSync(join(benchRoot, "cases.lock.json"))).toEqual(before);
});

it("keeps selected conventions when laptop reports go outside the repo without changing old suite arguments", () => {
  const options = { repo: "/repo", reportDir: "/report", job: { reviewer: "claude", graph: false }, web: "off", timeout: 900 };
  const old = ["review", "--cwd", "/repo", "--report-dir", "/report", "--reviewer", "claude", "--reviewer-web", "off", "--timeout", "900", "--no-color", "--no-graph"];
  expect(laptopReviewArgs(options)).toEqual(old);
  const args = laptopReviewArgs({ ...options, instructionsRef: "abc", configPath: "/repo/.openqodex/config.yaml" });
  expect(args.slice(args.indexOf("--instructions-ref"), args.indexOf("--instructions-ref") + 2)).toEqual(["--instructions-ref", "abc"]);
  expect(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2)).toEqual(["--config", "/repo/.openqodex/config.yaml"]);
});

it("does not leave chosen fixture configs ignored in a fresh checkout", () => {
  const paths = ["violation", "exception", "no-rule"].map((name) => `benchmark/suites/conventions/${name}/base/.openqodex/config.yaml`);
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--", ...paths], { cwd: repoRoot, encoding: "utf8" });
  expect(ignored.status, ignored.stderr + ignored.stdout).toBe(1);
  for (const path of paths) expect(readFileSync(join(repoRoot, path), "utf8")).toContain("instructions_files:");
});

it("does not penalize a duplicated literal in the no-rule control but still rejects invented rules", () => {
  const spec = JSON.parse(readFileSync(join(benchRoot, "suites/conventions/no-rule/case.json"), "utf8"));
  const finding = { file_path: "app/server.py", line_number: 24, category: "maintainability", title: "A magic number duplicates the page size", description: "Use PAGE_SIZE for the limit." };
  expect(classify(finding, spec).outcome).toBe("accepted");
  const score = scoreSample({ spec, report: { findings: [finding], completion: { status: "complete" } }, brief: "" });
  expect(score.controls).toEqual({ hit: 1, of: 1 });
  expect(classify({ ...finding, title: "CONTRIBUTING.md forbids this change", description: "An owner rule was violated." }, spec).outcome).toBe("false");
});
