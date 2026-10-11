// Phase timings in report.json, end to end: the built CLI on the demo repo
// with the real scanners. The review case plays the model provider with the
// golden run's Claude Code stand-in (tests/golden/stand-ins/claude.cjs),
// which replays one frozen answer; everything else is real. As in the golden
// run, the review case fixes the demo's secret, so the answer fits the
// change, and skips the two scanners that read live data; the scan case runs
// every scanner, semgrep (the slowest) included.
//
// Ways it could fail, written before the code:
//  1. Scan time hides in wall time: scan_ms is missing or below the slowest
//     scanner's durationMs.
//  2. A phase is left out of the timings, so the phases, which run one after
//     another, add up to more than 5% under total_ms.
//  3. A phase is counted twice, or total_ms is a sum instead of the time
//     that passed, so the phases add up to more than total_ms.
//  4. Reviewer time hides in wall time: reviewer_ms is below the duration
//     the reviewer record gives.
//  5. A scan report names phases a scan never runs.
import { chmodSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Report } from "@openqodex/core";
import "./global-setup.js";
import { demo, readJson, reportDir, root, run } from "./support.js";
import type { Result } from "./support.js";
import { fixDemoSecret } from "../golden/fixture-secret.mjs";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Timings = Record<string, number>;
const REVIEW_PHASES = ["change_ms", "scan_ms", "graph_ms", "brief_ms", "reviewer_ms", "finalize_ms"];
const SCAN_PHASES = ["change_ms", "scan_ms"];

// The phases a run went through one after another add up to no more than
// the time that passed, and to no less than 95% of it.
function addsUp(timings: Timings, phases: string[]): void {
  const sum = phases.reduce((s, k) => s + timings[k]!, 0);
  expect(sum, JSON.stringify(timings)).toBeLessThanOrEqual(timings.total_ms!);
  expect(sum, JSON.stringify(timings)).toBeGreaterThanOrEqual(timings.total_ms! * 0.95);
}

function slowestScanner(report: Report): number {
  return Math.max(...report.scanners.map((s) => s.durationMs));
}

// The golden run's Claude Code stand-in, on its own PATH folder with the frozen answer.
function provider(): string {
  const folder = tempDir("oq-e2e-provider-");
  writeFileSync(join(folder, "claude"), `#!${process.execPath}\n${readFileSync(join(root, "tests/golden/stand-ins/claude.cjs"), "utf8")}`);
  chmodSync(join(folder, "claude"), 0o755);
  cpSync(join(root, "tests/golden/stand-ins/submission.json"), join(folder, "submission.json"));
  return folder;
}

describe("scan", () => {
  let scan: Result;
  let report: Report;
  beforeAll(() => {
    const dir = demo("timings-scan");
    scan = run("timings-scan", dir, ["scan"]);
    report = readJson<Report>(join(reportDir(dir), "report.json"));
  }, 600_000);

  it("1, 2, 3, 5. times the change and the scan, scan_ms covers the slowest scanner, and no other phase is named", () => {
    expect(scan.status, scan.stderr).toBe(0);
    const timings = (report as { timings?: Timings }).timings;
    expect(timings, "report.json has no timings").toBeDefined();
    expect(Object.keys(timings!).sort()).toEqual(["change_ms", "scan_ms", "total_ms"]);
    expect(timings!.scan_ms).toBeGreaterThanOrEqual(slowestScanner(report));
    addsUp(timings!, SCAN_PHASES);
  });
});

describe("review", () => {
  let review: Result;
  let report: Report;
  beforeAll(() => {
    const dir = demo("timings-review");
    fixDemoSecret(dir);
    const path = [provider(), dirname(process.execPath), process.env.PATH].join(delimiter);
    review = run("timings-review", dir, ["review", "--reviewer", "claude", "--skip", "semgrep,osv-scanner", "--format", "json", "--no-color"], { env: { PATH: path, CLAUDECODE: undefined } });
    report = readJson<Report>(join(reportDir(dir), "report.json"));
  }, 600_000);

  it("1, 2, 3, 4. times every phase, scan_ms covers the slowest scanner and reviewer_ms the reviewer", () => {
    expect([0, 1], review.stderr).toContain(review.status);
    const timings = (report as { timings?: Timings }).timings;
    expect(timings, "report.json has no timings").toBeDefined();
    expect(Object.keys(timings!).sort()).toEqual([...REVIEW_PHASES, "total_ms"].sort());
    for (const [key, ms] of Object.entries(timings!)) expect(Number.isInteger(ms) && ms >= 0, `${key}: ${ms}`).toBe(true);
    expect(timings!.scan_ms).toBeGreaterThanOrEqual(slowestScanner(report));
    const reviewer = report.completion && "reviewer" in report.completion ? report.completion.reviewer : null;
    expect(reviewer, "the report names no reviewer").not.toBeNull();
    expect(timings!.reviewer_ms).toBeGreaterThanOrEqual((reviewer as { duration_ms: number }).duration_ms);
    addsUp(timings!, REVIEW_PHASES);
  });
});
