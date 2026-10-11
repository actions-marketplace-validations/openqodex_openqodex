// The scanner-only trend gate, as the bench-scan CI job runs it:
//
//   node benchmark/trend.mjs --mode scan --against-run <run folder> --summary <file>
//
// A scanner-only run folder that is not in the index is compared exactly
// with the accepted scanner-only entry of its group; the verdict is the
// exit code, and the trend table and the verdict are written for the job's
// summary. The runs here are saved the way run.mjs saves a scanner-only
// pass (a scan.json per sample, scored by score.mjs saveScore), published
// the way publish-run.mjs indexes a run, and accepted by trend.mjs
// --accept. Each candidate is one the real scanner printed on the planted
// case (benchmark/test/scan.test.mjs).
//
// Failures, written before the code:
// 1. A scanner change lowers the scanner-only score and CI stays green: a
//    bug the accepted run found and this run misses, a candidate nobody
//    credits that the accepted run did not raise, or a clean change that
//    starts drawing candidates passes the gate.
// 2. A scanner change raises the score and the index keeps the old number,
//    so a later fall back to it passes: any change of the score fails the
//    gate and prints the steps that record the run as the accepted one.
// 3. The gate passes because there is nothing to compare with: a run whose
//    group has no accepted entry fails and says how to record one.
// 4. A Semgrep registry update reads as a product regression and turns
//    every pull request red: when the rule packs differ from the accepted
//    run's, each difference is printed as a warning and the gate passes.
//    An osv.dev hash change does not excuse a drop, since that hash also
//    covers the osv-scanner adapter's own messages.
// 5. Two passes that differ are judged by the first: a run whose
//    identical.json says the passes differ fails the gate. A run that lacked
//    a scanner fails it too, naming the scanner rather than its bugs alone.
// 6. A red job does not say why: the summary file holds the trend table,
//    the verdict and each bug the run lost.
// 7. The plain trend over the index compares scanner-only entries with the
//    review runs' noise test, which reads a lost bug as noise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { externalOf } from "../lib/external.mjs";
import { publishRun } from "../publish-run.mjs";
import { saveScore } from "../score.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const TREND = fileURLToPath(new URL("../trend.mjs", import.meta.url));
const trend = (args) => {
  const r = spawnSync(process.execPath, [TREND, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const candidate = (id, source, ruleId, filePath, lineStart, message) => ({ id, token: `${source}:${ruleId}`, source, ruleId, filePath, lineStart, lineEnd: lineStart, severity: "medium", message, reference: null, reviewSeverity: "minor" });
// Real candidates, as the pinned scanners printed them on the planted cases.
const SC2115 = candidate("c1", "shellcheck", "SC2115", "scripts/deploy.sh", 7, 'Use "${var:?}" to ensure this never expands to / .');
const OSV = candidate("c2", "osv-scanner", "GHSA-35jh-r3h4-6jhm", "package-lock.json", 11, "lodash@4.17.15: GHSA-35jh-r3h4-6jhm (CVE-2021-23337). Command Injection in lodash");
const OSV_NEW = candidate("c3", "osv-scanner", "GHSA-xxxx-yyyy-zzzz", "package-lock.json", 11, "lodash@4.17.15: GHSA-xxxx-yyyy-zzzz. A new advisory in lodash");
const STRAY = candidate("c4", "semgrep", "python.lang.best-practice.open-never-closed", "app/server.py", 40, "File opened but never closed.");
const B101 = candidate("c1", "bandit", "B101", "tests/test_money.py", 21, "B101: Use of assert detected.");

const PACKS = (sha) => [
  { pack: "p/default", sha256: sha, bytes: 2195213 },
  { pack: "p/secrets", sha256: "7c0b0163d7cbfe44f16cec78556662655bedeec1d41c6e091ddef5d85c1d5eff", bytes: 82768 },
  { pack: "p/security-audit", sha256: "5509b33efc0c08e2134ccb76f2c7172065f7ba4a89f28799661029e274c306c7", bytes: 433040 },
];
const SHA_A = "0f73d6aaf812385878f945dad0fa829fe4fb5a934d4c4ae674ce2b1bd8ff66ed";
const SHA_B = "1f73d6aaf812385878f945dad0fa829fe4fb5a934d4c4ae674ce2b1bd8ff66ed";

const ran = (scanner, extra = {}) => ({ scanner, status: "ran", version: "1", rawCount: 1, keptCount: 1, durationMs: 1, reason: null, ...extra });
const scanOf = (cands, sha) => ({
  candidates: cands,
  scanners: [ran("semgrep", { rules: PACKS(sha) }), ran("shellcheck"), ran("osv-scanner"), ran("bandit")],
  trail: cands.map((c) => ({ token: c.token, file: c.filePath, lineStart: c.lineStart, lineEnd: c.lineEnd, severity: c.severity, stage: "kept", id: c.id })),
  fixturesDropped: 0,
  secretFingerprints: [],
});

const CASES = ["clean-python-feature", "demo-polyglot"];
const BASE = { demo: [SC2115, OSV], clean: [] };

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
};

// A scored scanner-only pass in <root>/<runId>, with each case's
// candidates, the Semgrep pack bytes every sample consumed, and the
// identical.json run.mjs --check-identical writes.
function scanRun(root, { runId, startedAt, commit, demo = BASE.demo, clean = BASE.clean, sha = SHA_A, identical = true, missing = [] }) {
  const out = join(root, runId);
  const caseId = (name) => `planted/${name}@00000000`;
  const jobs = CASES.map((name) => ({ jobId: `${caseId(name)}/scan/1`, caseId: caseId(name), case: name, config: "scan", repeat: 1 }));
  const scans = { "demo-polyglot": scanOf(demo, sha), "clean-python-feature": scanOf(clean, sha) };
  const samples = [];
  for (const job of jobs) {
    write(join(out, "cases", `${job.case}.json`), readFileSync(new URL(`../cases/${job.case}/case.json`, import.meta.url), "utf8"));
    const dir = join(out, "samples", job.case, "scan", "1");
    const sample = { jobId: job.jobId, caseId: job.caseId, firstAttempt: true, case: job.case, config: "scan", reviewer: null, graph: "off", repeat: 1, attempt: 1, started_at: startedAt, exit: 0, signal: null, wallMs: 3000, status: "complete" };
    write(join(dir, "sample.json"), sample);
    write(join(dir, "report", "scan.json"), scans[job.case]);
    samples.push({ caseId: job.caseId, startedAt, scan: scans[job.case] });
  }
  const external = externalOf({ samples, preflight: { toolchainHash: "a".repeat(64), scannerVersions: { semgrep: "1.94.0" }, missing: [] } });
  write(join(out, "manifest.json"), {
    version: 3,
    runId,
    started_at: startedAt,
    mode: "scan",
    path: "laptop",
    suite: "planted",
    split: "dev",
    build: { commit, short: commit.slice(0, 7), dirty: false, bundleHash: "c".repeat(64), cliVersion: "0.14.0" },
    reviewer: null,
    reviewers: {},
    scannersComplete: missing.length === 0,
    scannersMissing: missing.map((scanner) => ({ scanner, state: "not_installed", detail: null })),
    draft: false,
    cases: CASES,
    caseIds: CASES.map(caseId),
    configs: ["scan"],
    repeat: 1,
    planned: jobs.length,
    jobs,
    external,
    ended: { at: startedAt, how: "finished", why: null, elapsedMin: 0.1 },
  });
  saveScore(out);
  write(join(out, "identical.json"), { version: 1, runId, identical, cause: identical ? null : "product", inputs: [], differences: identical ? [] : ["samples/demo-polyglot/scan/1/report/scan.json: candidates.0.lineStart"], passes: [{ folder: runId, elapsedMin: 0.1 }, { folder: `${runId}-pass2`, elapsedMin: 0.1 }] });
  return out;
}

const ACCEPTED = { runId: "2026-10-11-aaaaaaa-planted-scan-ci", startedAt: "2026-10-11T09:00:00.000Z", commit: "a".repeat(40) };
const NEXT = { runId: "2026-10-11-bbbbbbb-planted-scan-ci", startedAt: "2026-10-11T10:00:00.000Z", commit: "b".repeat(40) };

// An index whose accepted scanner-only entry is a run of `accepted`'s
// candidates, published and accepted as the session does it.
function acceptedIndex(accepted = {}) {
  const root = tempDir("oq-bench-scan-trend-");
  const index = join(root, "index");
  const run = scanRun(join(root, "results"), { ...ACCEPTED, ...accepted });
  publishRun(run, { dryRun: true, writeIndex: true, runs: join(index, "runs"), out: tempDir("oq-bench-scan-trend-asset-") });
  const r = trend(["--accept", ACCEPTED.runId, "--by", "Sid", "--index", index, "--results", dirname(run)]);
  expect(r.status, r.out).toBe(0);
  return { root, index };
}

// The gate on a run of `next`'s candidates, with its summary file.
function gate({ root, index }, next = {}) {
  const run = scanRun(join(root, "ci"), { ...NEXT, ...next });
  const summary = join(root, `summary-${basename(run)}-${Math.random().toString(16).slice(2)}.md`);
  const r = trend(["--mode", "scan", "--against-run", run, "--index", index, "--summary", summary]);
  return { ...r, summary: existsSync(summary) ? readFileSync(summary, "utf8") : "" };
}

describe("a scanner change lowers the scanner-only score and CI stays green", () => {
  it("passes a run whose scores equal the accepted run's, and writes the trend table to the summary", () => {
    const at = acceptedIndex();
    const r = gate(at);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/equal the accepted run's/);
    // The trend table: a header row, the accepted run and this run.
    expect(r.summary).toMatch(/^\| Started \| Run \| Build \|/m);
    expect(r.summary).toContain(`| ${ACCEPTED.runId} |`);
    expect(r.summary).toContain(`| ${NEXT.runId} |`);
    expect(r.summary).toMatch(/this run/);
    expect(r.summary).toMatch(/equal the accepted run's/);
  });

  it("fails a run that misses a bug the accepted run found, and names the bug in the output and the summary", () => {
    const r = gate(acceptedIndex(), { demo: [OSV] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/regression/i);
    expect(r.out).toMatch(/shell-rm-unquoted/);
    expect(r.summary).toMatch(/shell-rm-unquoted/);
    expect(r.summary).toMatch(/regression/i);
  });

  it("fails a run that raises a candidate nobody credits, which the accepted run did not raise", () => {
    const r = gate(acceptedIndex(), { demo: [SC2115, OSV, STRAY] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/regression/i);
    expect(r.out).toMatch(/unresolved/i);
  });

  it("fails a run in which a clean change starts drawing candidates", () => {
    const r = gate(acceptedIndex(), { clean: [B101] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/regression/i);
    expect(r.out).toMatch(/clean-python-feature/);
  });
});

describe("a scanner change raises the score and the index keeps the old number", () => {
  it("fails a better run and prints the steps that record it as the accepted run", () => {
    const r = gate(acceptedIndex({ demo: [OSV] }));
    expect(r.status, r.out).toBe(1);
    expect(r.out).not.toMatch(/regression/i);
    expect(r.out).toMatch(/shell-rm-unquoted/);
    expect(r.out).toContain(`publish-run.mjs <results>/${NEXT.runId} --dry-run --write-index`);
    expect(r.out).toContain(`trend.mjs --accept ${NEXT.runId} --by <name>`);
    expect(r.summary).toContain(`trend.mjs --accept ${NEXT.runId}`);
  });
});

describe("the gate passes because there is nothing to compare with", () => {
  it("fails a run whose group has no accepted entry, and says how to record one", () => {
    const root = tempDir("oq-bench-scan-trend-");
    const r = gate({ root, index: join(root, "index") });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/no scanner-only run is accepted/i);
    expect(r.out).toContain(`trend.mjs --accept ${NEXT.runId}`);
    expect(r.summary).toMatch(/no scanner-only run is accepted/i);
  });
});

describe("a Semgrep registry update reads as a product regression and turns every pull request red", () => {
  it("passes with a warning when the rule packs differ, naming the packs, each difference and the steps to record the run", () => {
    const r = gate(acceptedIndex(), { demo: [OSV], sha: SHA_B });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/warning/i);
    expect(r.out).toMatch(/Semgrep rule packs/);
    expect(r.out).toMatch(/shell-rm-unquoted/);
    expect(r.out).toContain(`trend.mjs --accept ${NEXT.runId}`);
    expect(r.summary).toMatch(/Semgrep rule packs/);
  });

  it("still fails a lost bug when only the osv.dev data differs, since that hash also covers the adapter's own messages", () => {
    const r = gate(acceptedIndex(), { demo: [OSV, OSV_NEW] });
    expect(r.status, r.out).toBe(1);
    const lost = gate(acceptedIndex(), { demo: [OSV_NEW] });
    expect(lost.status, lost.out).toBe(1);
    expect(lost.out).toMatch(/osv\.dev advisory data/);
    expect(lost.out).toMatch(/shell-rm-unquoted/);
  });
});

describe("two passes that differ are judged by the first", () => {
  it("fails a run whose identical.json says its two passes differ, and names the difference", () => {
    const r = gate(acceptedIndex(), { identical: false });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/two passes/i);
    expect(r.out).toContain("samples/demo-polyglot/scan/1/report/scan.json");
    expect(r.summary).toMatch(/two passes/i);
  });
});

describe("a run that lacked a scanner is judged as a scanner change", () => {
  it("fails a run whose manifest says a scanner was not installed, and names it", () => {
    const r = gate(acceptedIndex(), { demo: [OSV], missing: ["shellcheck"] });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/shellcheck/);
    expect(r.out).toMatch(/not installed/);
  });
});

describe("the plain trend compares scanner-only entries with the review runs' noise test", () => {
  it("raises the alarm when a newer scanner-only entry in the index lost a bug the accepted one found", () => {
    const at = acceptedIndex();
    const run = scanRun(join(at.root, "results"), { ...NEXT, demo: [OSV] });
    publishRun(run, { dryRun: true, writeIndex: true, runs: join(at.index, "runs"), out: tempDir("oq-bench-scan-trend-asset-") });
    const r = trend(["--mode", "scan", "--index", at.index]);
    expect(r.status, r.out).toBe(1);
    expect(r.out).toMatch(/shell-rm-unquoted/);
  });
});
