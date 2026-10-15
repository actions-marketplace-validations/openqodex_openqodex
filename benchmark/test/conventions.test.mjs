// Failures guarded: the convention cases enter the frozen corpus, cannot
// materialise in either review shape, or lose their selected rules when
// the laptop runner uses an external report folder. A fixture config must
// also survive git add so a fresh clone reviews the same cases. Format 3
// must credit the cited violation and count control findings as false.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { benchRoot, caseHash, listCases, readCase, repoRoot } from "../lib/cases.mjs";
import { laptopReviewArgs } from "../lib/runner.mjs";
import { originOf, scoreJob } from "../lib/score.mjs";

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

it.each(["claude", "model:gpt-6.1-sol"])("does not treat a suite-qualified convention case as a nested path for %s", (reviewer) => {
  const out = mkdtempSync(join(tmpdir(), "oq-qualified-convention-"));
  roots.push(out);
  const run = spawnSync(process.execPath, [join(benchRoot, "run.mjs"), "--cases", "conventions/violation", "--materialise-only", "--reviewers", reviewer, "--out", out], { cwd: repoRoot, encoding: "utf8" });
  expect(run.status, run.stderr).toBe(0);
  const proof = JSON.parse(readFileSync(join(out, "proof.json"), "utf8"));
  expect(proof.suite).toBe("conventions");
  expect(run.stdout).toContain("1 of 1 cases proved");
  expect(run.stdout).toContain(`conventions/violation@${caseHash("violation", join(benchRoot, "suites/conventions")).slice(0, 8)}`);
  expect(run.stdout).not.toContain("conventions/conventions/");
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

const conventionRoot = join(benchRoot, "suites/conventions");
const conventionFinding = {
  file_path: "app/server.py", line_number: 41, category: "maintainability", severity: "minor",
  title: "The handler breaks CONTRIBUTING.md#verb-noun",
  problem: "The rule requires new route handlers to use verb_noun names with the HTTP method first.",
  consequence: "health_check does not follow the chosen naming convention.",
  fix: "Rename health_check to get_health.",
};

function scoreConvention(name, findings) {
  const spec = readCase(name, conventionRoot);
  const caseId = `conventions/${name}@${caseHash(name, conventionRoot).slice(0, 8)}`;
  return scoreJob({
    job: { jobId: `${caseId}/fixture/1`, caseId, case: name, config: "fixture", repeat: 1 },
    spec, origin: originOf("conventions"), brief: "",
    report: { findings, completion: { status: "complete" } },
  });
}

it("does not miss a cited convention violation in the format 3 score", () => {
  const hit = scoreConvention("violation", [conventionFinding]);
  expect(hit.origin).toBe("planted");
  expect(hit.findings[0].outcome).toBe("hit");
  expect(hit.issueRecall.all).toEqual({ hit: 1, of: 1 });
  expect(hit.precision).toEqual({ correct: 1, unresolved: 0, of: 1 });
  expect(scoreConvention("violation", []).issueRecall.all).toEqual({ hit: 0, of: 1 });
});

it.each(["CONTRIBUTING.md", "verb_noun"])("does not credit a violation naming only %s without the rule citation", (word) => {
  const score = scoreConvention("violation", [{
    ...conventionFinding, title: `Follow ${word}`,
    problem: "The handler breaks a chosen convention.",
    consequence: "Its name does not follow the convention.",
    fix: "Rename the handler.",
  }]);
  expect(score.findings[0].outcome).not.toBe("hit");
  expect(score.issueRecall.all).toEqual({ hit: 0, of: 1 });
});

it.each(["exception", "no-rule"])("counts a convention finding on the %s control as false in format 3", (name) => {
  const spec = readCase(name, conventionRoot);
  expect(spec.clean).toBe(true);
  expect(spec.bugs).toEqual([]);
  expect(spec.extras).toBeUndefined();
  expect(readFileSync(join(conventionRoot, name, "change/app/server.py"), "utf8"))
    .toBe(readFileSync(join(conventionRoot, "violation/change/app/server.py"), "utf8"));
  const falseAlarm = scoreConvention(name, [conventionFinding]);
  expect(falseAlarm.findings[0].outcome).toBe("false");
  expect(falseAlarm.precision).toEqual({ correct: 0, unresolved: 0, of: 1 });
  expect(falseAlarm.controls).toEqual({ hit: 0, of: 1 });
  expect(scoreConvention(name, []).controls).toEqual({ hit: 1, of: 1 });
});
