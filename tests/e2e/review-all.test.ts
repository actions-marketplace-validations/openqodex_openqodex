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
// 5. `review --all` without `--agent` prints a scan-only report instead of
//    the brief (the founder's rule: the review always sits on the scanners).
// 6. A clean repo gives a brief that does not say the scanners found nothing.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { baseline, demo, git, readBrief, readJson, report, root, run, skipNetwork, submission } from "./support.js";
import type { Brief, Result } from "./support.js";

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
    brief = readBrief(dir);
    const raised = [brief.candidates.find((c) => c.filePath === "app/config.py")!, brief.candidates.find((c) => c.filePath === "app/search.py")!];
    writeFileSync(join(brief.path, "agent-findings.json"), JSON.stringify(submission(brief.changeId, brief.candidates, raised)));
    finalize = run("all-review-finalize", dir, ["review", "--finalize", "--format", "json"]);
    finalReport = report(dir);
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
    const r = run("all-finalize-bad-line", dir, ["review", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("line 9999 of app/server.py");
  });
});

it("review --all with --base exits 2 with one line", () => {
  const r = run("all-with-base", baseline(), ["review", "--all", "--base", "x"]);
  expect(r.status).toBe(2);
  expect(r.stderr.trim().split("\n")).toHaveLength(1);
});

it("review --all without --agent prints the brief and the line that the agent finishes it, never a scan report", () => {
  const dir = demo("all-human");
  const r = run("all-without-agent", dir, ["review", "--all"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^# OpenQodex review brief: the whole repository\n/);
  expect(r.stdout).toContain("the review is done when your coding agent writes its findings and runs the finalize command");
  expect(readJson<{ kind: string; finalized: boolean }>(join(dir, ".openqodex/latest.json"))).toMatchObject({ kind: "review", finalized: false });
});

it("review --all on a clean repo says the scanners found nothing", () => {
  const r = run("all-clean", baseline(), ["review", "--all", "--agent"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Nothing from the scanners: no scanner reported anything in this repository.");
  expect(r.stdout).toContain("None: the scanners reported nothing.");
});
