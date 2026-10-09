// `review --all`, the whole-repo review, through the built CLI. Failures this
// file guards against:
// 1. A planted bug on a line no change touched is filtered out, so the whole
//    repo review misses what the scanners found (the changed-line filter
//    leaking into --all).
// 2. The brief has no "Where to start": the graph's most-called symbols are
//    missing, so the agent starts reading a large repo at random.
// 3. Finalize treats the whole repo like a change: an agent finding on a
//    valid line lands in outside_change, or the run's id does not match.
// 4. `--all` with `--base` or `--uncommitted` silently picks one scope.
// 5. `review --all` without `--agent` prints a scan-only report as if it were
//    a review (the founder's rule: the review always sits on the scanners);
//    with no reviewer it must exit 2 and print none.
// 6. A clean repo gives a brief that does not say the scanners found nothing.
// 7. An --all run replaces latest.json, the receipt the push gate reads, so
//    a passing change review stops counting.
// 8. A hot function in an excluded folder reaches "Where to start".
// 9. The owners' instructions are missing from the brief, or a file over the
//    limit is cut instead of refused.
// 10. A file of many short lines crashes the lens selection, or a pattern in
//     a file late in the alphabet gets no lens once earlier files are large.
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate, Report } from "@openqodex/core";
import "./global-setup.js";
import { baseline, demo, git, noReviewerEnv, readJson, root, run, skipNetwork, submission } from "./support.js";
import type { Brief, Result } from "./support.js";
import { removeTempDirs } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// The newest whole-repo run, from its own receipt (never latest.json).
const allDir = (dir: string) => join(dir, readJson<{ dir: string }>(join(dir, ".openqodex/latest-all.json")).dir);
function readAllBrief(dir: string): Brief {
  const path = allDir(dir);
  return { path, candidates: readJson<Candidate[]>(join(path, "candidates.json")), changeId: readJson<{ change_id: string }>(join(path, "manifest.json")).change_id };
}

type Bug = { id: string; file: string; lines: [number, number]; detectors: { scanner: string; rule_id: string }[] | null };
const expected = readJson<{ bugs: Bug[] }>(join(root, "examples/demo-repo/expected.json"));

describe("review --all on the demo repo", () => {
  let dir: string; let agent: Result; let brief: Brief; let finalize: Result; let finalReport: Report;
  beforeAll(() => {
    // The planted change is committed, so no line is changed: every
    // candidate below comes from the whole-repo scope, not from a diff.
    dir = demo("all");
    git(dir, "add", "-A"); git(dir, "commit", "-qm", "Planted");
    agent = run("all-review-agent", dir, ["review", "--all", "--agent"]);
    brief = readAllBrief(dir);
    const raised = [brief.candidates.find((c) => c.filePath === "app/config.py")!, brief.candidates.find((c) => c.filePath === "app/search.py")!];
    writeFileSync(join(brief.path, "agent-findings.json"), JSON.stringify(submission(brief.changeId, brief.candidates, raised)));
    finalize = run("all-review-finalize", dir, ["review", "--all", "--finalize", "--format", "json"]);
    finalReport = readJson<Report>(join(allDir(dir), "report.json"));
  }, 600_000);

  it("names every planted scanner bug as a candidate on its file and lines, with nothing left uncommitted", () => {
    expect(agent.status).toBe(0);
    for (const bug of expected.bugs) {
      if (bug.detectors === null) continue;
      const detectors = bug.detectors.filter((d) => !(["semgrep", "osv-scanner"].includes(d.scanner) && skipNetwork(`${bug.id} by ${d.scanner}`)));
      if (detectors.length === 0) continue;
      const hit = brief.candidates.some((c) => detectors.some((d) => c.token === `${d.scanner}:${d.rule_id}`) && c.filePath === bug.file && c.lineStart <= bug.lines[1] && Math.max(c.lineStart, c.lineEnd) >= bug.lines[0]);
      expect(hit, `${bug.id} in ${bug.file}`).toBe(true);
    }
  });
  it("starts the brief with the whole-repo header and lists the most-called symbol with its callers", () => {
    expect(agent.stdout).toMatch(/^# OpenQodex review brief: the whole repository\n/);
    expect(agent.stdout).toMatch(/- Scope: the whole repository, \d+ files and \d+ lines/);
    expect(agent.stdout).toContain("## Where to start");
    expect(agent.stdout).toMatch(/- `get_db` \(function\) app\/server\.py:\d+: 2 callers; called at app\/server\.py:\d+/);
    expect(agent.stdout).not.toContain("## Diff");
  });
  it("finalizes with both raised candidates as findings and nothing outside the change", () => {
    expect(finalize.status).toBe(0);
    expect(finalReport.findings.map((f) => f.file_path).sort()).toEqual(["app/config.py", "app/search.py"]);
    expect(finalReport.outside_change).toEqual([]);
  });
  it("rejects a finding on a line that does not exist in the file", () => {
    const body = submission(brief.changeId, brief.candidates, []);
    body.findings.push({ severity: "minor", category: "bug", confidence: 1, file_path: "app/server.py", line_number: 9999, title: "Past the end", description: "No such line", suggested_change: null, source: null, candidate: null });
    writeFileSync(join(brief.path, "agent-findings.json"), JSON.stringify(body));
    const r = run("all-finalize-bad-line", dir, ["review", "--all", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("line 9999 of app/server.py");
  });
});

it("review --all with --base exits 2 with one line", () => {
  const r = run("all-with-base", baseline(), ["review", "--all", "--base", "x"]);
  expect(r.status).toBe(2);
  expect(r.stderr.trim().split("\n")).toHaveLength(1);
});

// The total review changed this case: plain `review --all` runs the whole
// review itself, so with no reviewer it exits 2 and writes no receipt.
it("review --all without --agent and with no reviewer exits 2, prints no report and writes no whole-repo receipt", () => {
  const dir = demo("all-human");
  const r = run("all-without-agent", dir, ["review", "--all"], { env: noReviewerEnv() });
  expect(r.status).toBe(2);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain("Full review unavailable");
  expect(existsSync(join(dir, ".openqodex/latest-all.json"))).toBe(false);
});

it("review --all leaves latest.json, the push gate's receipt, as the change review wrote it", () => {
  const dir = demo("all-receipt");
  expect(run("all-receipt-change", dir, ["review", "--agent"]).status).toBe(0);
  const before = readFileSync(join(dir, ".openqodex/latest.json"), "utf8");
  expect(run("all-receipt-all", dir, ["review", "--all", "--agent"]).status).toBe(0);
  expect(readFileSync(join(dir, ".openqodex/latest.json"), "utf8")).toBe(before);
});

it("review --all never names a symbol from an excluded folder under Where to start", () => {
  const dir = baseline();
  mkdirSync(join(dir, "vendor"));
  writeFileSync(join(dir, "vendor/hot.py"), "def vendored_helper():\n    return 1\n");
  writeFileSync(join(dir, "app/use.py"), "from vendor.hot import vendored_helper\n\n\ndef a():\n    return vendored_helper()\n\n\ndef b():\n    return vendored_helper()\n");
  writeFileSync(join(dir, ".openqodex.yaml"), "review:\n  paths:\n    exclude: [\"vendor/**\"]\n");
  const r = run("all-excluded-graph", dir, ["review", "--all", "--agent"]);
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("vendored_helper` (function) vendor/");
  expect(r.stdout).not.toContain("vendor/hot.py");
});

it("review --all puts the owners' instructions in the brief and refuses a file over 32 KB", () => {
  const dir = baseline();
  mkdirSync(join(dir, ".openqodex"), { recursive: true });
  writeFileSync(join(dir, ".openqodex/custom-instructions.md"), "Never flag the print calls in scripts/.\n");
  const r = run("all-instructions", dir, ["review", "--all", "--agent"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("## Instructions from this repo's owners");
  expect(r.stdout).toContain("Never flag the print calls in scripts/.");
  writeFileSync(join(dir, ".openqodex/custom-instructions.md"), "x".repeat(33 * 1024));
  const big = run("all-instructions-too-big", dir, ["review", "--all", "--agent"]);
  expect(big.status).toBe(2);
  expect(big.stderr).toContain("over the 32 KB limit");
});

it("review --all survives a file of 400,000 short lines and still finds a pattern in a file after 6 MB of earlier files", () => {
  const dir = baseline();
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a/lines.txt"), "x\n".repeat(400_000));
  writeFileSync(join(dir, "a/big1.txt"), `${"y".repeat(99)}\n`.repeat(30_000));
  writeFileSync(join(dir, "a/big2.txt"), `${"z".repeat(99)}\n`.repeat(30_000));
  mkdirSync(join(dir, "zz"));
  cpSync(join(root, "examples/demo-repo/planted/app/search.py"), join(dir, "zz/search.py"));
  const r = run("all-lens-sampling", dir, ["review", "--all", "--agent"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("### sql-string-concatenation");
});

it("review --all on a clean repo says the scanners found nothing", () => {
  const r = run("all-clean", baseline(), ["review", "--all", "--agent"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Nothing from the scanners: no scanner reported anything in this repository.");
  expect(r.stdout).toContain("None: the scanners reported nothing.");
});
