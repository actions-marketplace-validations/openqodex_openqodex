// The scan record, end to end: the built CLI on the demo repo with the real
// scanner binaries. scan.json names what the selector chose for each
// scanner, and holds one trail entry per raw finding with the stage of the
// pipeline that dropped it, or its candidate id when it was kept. Without
// that record a finding the changed-line filter, the fixture filter,
// disabled_rules or dedup removed leaves nothing behind, and a scanner's
// work reads as a miss.
//
// Ways it could fail, written before the code:
//  1. The selection is missing, or does not name every built-in scanner
//     with what the selector chose (wanted, paths, projects, skip).
//  2. A raw finding has no trail entry, so a scanner's entries add up to
//     less than its rawCount.
//  3. A finding dedup merged leaves no record: gitleaks's stripe key, which
//     semgrep's stripe rule also reports, is not a merged entry pointing at
//     the semgrep candidate.
//  4. A finding the changed-line filter dropped leaves no record, whether
//     its file is outside the change or only its lines are.
//  5. A finding in a fixture file, or one disabled_rules names, leaves no
//     record.
//  6. The stage counts on a scanner's summary disagree with its entries.
//  7. A kept entry names no candidate, or a candidate has no kept entry.
//  8. The trail carries message text, which can quote a secret.
//  9. A review writes no trail, or another trail than a scan of the same
//     change.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate, ScannerRunSummary } from "@openqodex/core";
import "./global-setup.js";
import { demo, generatedSecret, git, readJson, reportDir, run, skipNetwork, writeConfig } from "./support.js";
import type { Result } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

type Selection = { scanner: string; wanted: boolean; paths: string[]; projects: string[]; skip: string | null };
type Entry = { token: string; file: string; lineStart: number; lineEnd: number; severity: string; stage: string; id?: string; into?: string };
type Stages = { changedLines: number; fixtures: number; rules: number; merged: number };
type Summary = ScannerRunSummary & { stages?: Stages; resolveMs?: number; files?: number };
type Scan = { candidates: Candidate[]; scanners: Summary[]; fixturesDropped: number; selection?: Selection[]; trail?: Entry[]; trailOmitted?: number };

const BUILTINS = [
  "semgrep", "gitleaks", "sqllint", "squawk", "sqlfluff", "osv-scanner", "cargo-deny", "actionlint", "zizmor", "hadolint", "trivy",
  "checkov", "tflint", "kube-linter", "kubeconform", "shellcheck", "ruff", "brakeman", "rubocop", "bandit", "oxlint", "golangci",
];
const ENTRY_KEYS = ["token", "file", "lineStart", "lineEnd", "severity", "stage", "id", "into"];
const STAGES = ["outside-change", "changed-lines", "fixture", "disabled-rule", "merged", "kept"];
// OpenQodex's own candidates about the change (a changed settings file, an
// added suppression comment) are trail entries too, but no scanner raised
// them, so they are not part of its rawCount.
const OWN_RULES = ["settings-file", "openqodex.suppression-added"];

const of = (scan: Scan, scanner: string): Entry[] => (scan.trail ?? []).filter((e) => e.token.startsWith(`${scanner}:`));
const own = (e: Entry): boolean => OWN_RULES.includes(e.token.slice(e.token.indexOf(":") + 1));
const count = (entries: Entry[], ...stages: string[]): number => entries.filter((e) => stages.includes(e.stage)).length;

// Every check that holds for any scan record this version writes.
function wellFormed(scan: Scan): void {
  expect(scan.selection, "scan.json has no selection").toBeDefined();
  expect(scan.trail, "scan.json has no trail").toBeDefined();
  for (const e of scan.trail!) {
    for (const key of Object.keys(e)) expect(ENTRY_KEYS, `trail entry key ${key}`).toContain(key);
    expect(STAGES).toContain(e.stage);
    expect(e.id !== undefined, JSON.stringify(e)).toBe(e.stage === "kept");
    expect(e.into !== undefined, JSON.stringify(e)).toBe(e.stage === "merged");
  }
  // 7. Kept entries and candidates, one to one.
  const kept = scan.trail!.filter((e) => e.stage === "kept");
  expect(kept.map((e) => e.id).sort()).toEqual(scan.candidates.map((c) => c.id).sort());
  for (const e of kept) {
    const c = scan.candidates.find((x) => x.id === e.id)!;
    expect({ token: e.token, file: e.file, lineStart: e.lineStart, lineEnd: e.lineEnd, severity: e.severity }).toEqual({ token: c.token, file: c.filePath, lineStart: c.lineStart, lineEnd: c.lineEnd, severity: c.severity });
  }
  // A merged entry points at a candidate on its own lines.
  for (const e of scan.trail!.filter((x) => x.stage === "merged")) {
    const c = scan.candidates.find((x) => x.id === e.into);
    expect(c, JSON.stringify(e)).toBeDefined();
    expect([c!.filePath, c!.lineStart, c!.lineEnd]).toEqual([e.file, e.lineStart, e.lineEnd]);
  }
  for (const s of scan.scanners) {
    const entries = of(scan, s.scanner);
    // 2. One entry per raw finding.
    expect(entries.filter((e) => !own(e)).length, `${s.scanner} trail against rawCount`).toBe(s.rawCount);
    // 6. The stage counts are the entries' stages.
    expect(s.stages, `${s.scanner} stages`).toEqual({
      changedLines: count(entries, "outside-change", "changed-lines"),
      fixtures: count(entries, "fixture"),
      rules: count(entries, "disabled-rule"),
      merged: count(entries, "merged"),
    });
    expect(count(entries, "kept")).toBe(s.keptCount);
    expect(s.resolveMs, `${s.scanner} resolveMs`).toBeGreaterThanOrEqual(0);
    expect(s.files, `${s.scanner} files`).toBeGreaterThanOrEqual(0);
  }
  expect(scan.fixturesDropped).toBe(count(scan.trail!, "fixture"));
  expect(scan.trailOmitted ?? 0).toBe(0);
}

describe("the demo scan", () => {
  let scanned: Result;
  let scan: Scan;
  let text: string;
  let secret: string;
  beforeAll(() => {
    const dir = demo("trail-scan");
    secret = generatedSecret(dir);
    const out = join(tempDir("oq-trail-report-"), "report");
    scanned = run("trail-scan", dir, ["scan", "--report-dir", out]);
    text = readFileSync(join(out, "scan.json"), "utf8");
    scan = JSON.parse(text) as Scan;
  }, 600_000);

  it("1. names all 22 built-in scanners with what the selector chose", () => {
    expect(scanned.status, scanned.stderr).toBe(0);
    expect(scan.selection?.map((c) => c.scanner)).toEqual(BUILTINS);
    for (const c of scan.selection!) expect(Object.keys(c).sort()).toEqual(["paths", "projects", "scanner", "skip", "wanted"]);
    for (const s of scan.scanners) {
      const c = scan.selection!.find((x) => x.scanner === s.scanner)!;
      if (s.status === "no_matching_files") expect([c.wanted, c.paths]).toEqual([false, []]);
      if (s.status === "ran") {
        expect(c.wanted).toBe(true);
        expect(c.paths.length).toBeGreaterThan(0);
        expect(s.files).toBe(c.paths.length);
      }
    }
    expect(scan.selection!.find((c) => c.scanner === "shellcheck")!.paths).toEqual(["scripts/deploy.sh"]);
  });

  it("2, 6, 7. holds one entry per raw finding, its stage counted on the summary", () => {
    wellFormed(scan);
    expect(scan.scanners.reduce((n, s) => n + s.rawCount, 0)).toBeGreaterThan(scan.candidates.length);
  });

  it("3. records gitleaks's stripe key as merged into semgrep's stripe candidate", () => {
    if (skipNetwork("the semgrep stripe merge")) return;
    const semgrep = scan.candidates.find((c) => c.token === "semgrep:generic.secrets.security.detected-stripe-api-key.detected-stripe-api-key");
    expect(semgrep, "no semgrep stripe candidate").toBeDefined();
    expect(of(scan, "gitleaks")).toEqual([
      { token: "gitleaks:stripe-access-token", file: "app/config.py", lineStart: 2, lineEnd: 2, severity: "high", stage: "merged", into: semgrep!.id },
    ]);
  });

  it("3. leaves a merged entry for every scanner a candidate names in alsoReportedBy", () => {
    for (const c of scan.candidates) {
      for (const token of c.alsoReportedBy ?? []) {
        expect(scan.trail!.some((e) => e.token === token && e.stage === "merged" && e.into === c.id), `${token} into ${c.id}`).toBe(true);
      }
    }
  });

  it("8. carries no message text and no secret", () => {
    expect(text).not.toContain(secret);
    const messages = new Set(scan.candidates.map((c) => c.message));
    for (const e of scan.trail!) for (const value of Object.values(e)) expect(messages.has(String(value))).toBe(false);
  });
});

// The demo, with a drop at every stage: an unchanged Terraform file in a
// folder the change touches (trivy and checkov read the whole folder), a
// committed shell script whose finding sits on a line the change keeps, a
// new script in a fixtures folder, and disabled_rules naming a hadolint rule
// the Dockerfile breaks.
describe("the demo with a drop at every stage", () => {
  const ONLY = "shellcheck,hadolint,trivy,checkov";
  let dir: string;
  let scanned: Result;
  let reviewed: Result;
  let scan: Scan;
  let review: Scan;
  beforeAll(() => {
    dir = demo("trail-drops");
    writeFileSync(
      join(dir, "infra/legacy.tf"),
      ['resource "aws_security_group" "legacy" {', '  name        = "legacy"', '  description = "Legacy SSH"', "", "  ingress {", '    description = "SSH"', "    from_port   = 22", "    to_port     = 22", '    protocol    = "tcp"', '    cidr_blocks = ["0.0.0.0/0"]', "  }", "}", ""].join("\n"),
    );
    writeFileSync(join(dir, "scripts/cleanup.sh"), "#!/bin/sh\nrm -rf $CLEAN_DIR/\n");
    git(dir, "add", "infra/legacy.tf", "scripts/cleanup.sh");
    git(dir, "commit", "-qm", "Legacy files", "--", "infra/legacy.tf", "scripts/cleanup.sh");
    appendFileSync(join(dir, "scripts/cleanup.sh"), 'echo "cleaned"\n');
    mkdirSync(join(dir, "scripts/fixtures"));
    writeFileSync(join(dir, "scripts/fixtures/seed.sh"), "#!/bin/sh\nrm -rf $SEED_DIR/\n");
    writeConfig(dir, 'review:\n  disabled_rules:\n    - "hadolint:DL3007"\n');
    scanned = run("trail-drops-scan", dir, ["scan", "--only", ONLY]);
    scan = readJson<Scan>(join(reportDir(dir), "scan.json"));
    reviewed = run("trail-drops-review", dir, ["review", "--agent", "--no-graph", "--only", ONLY]);
    review = readJson<Scan>(join(reportDir(dir), "scan.json"));
  }, 600_000);

  it("2, 6, 7. holds one entry per raw finding, its stage counted on the summary", () => {
    expect(scanned.status, scanned.stderr).toBe(0);
    wellFormed(scan);
  });

  it("4. records a finding in a file the change does not touch as outside the change", () => {
    const outside = scan.trail!.filter((e) => e.stage === "outside-change");
    expect(outside.some((e) => e.token === "trivy:AWS-0107" && e.file === "infra/legacy.tf"), JSON.stringify(outside)).toBe(true);
    expect(outside.every((e) => e.file === "infra/legacy.tf"), JSON.stringify(outside)).toBe(true);
  });

  it("4. records a finding on a line the change kept as dropped by the changed-line filter", () => {
    expect(scan.trail!.filter((e) => e.file === "scripts/cleanup.sh").map((e) => [e.token, e.lineStart, e.stage])).toEqual([
      ["shellcheck:SC2086", 2, "changed-lines"],
      ["shellcheck:SC2115", 2, "changed-lines"],
    ]);
  });

  it("5. records a finding in a fixture file as dropped by the fixture filter", () => {
    const seed = scan.trail!.filter((e) => e.file === "scripts/fixtures/seed.sh");
    expect(seed.length).toBeGreaterThan(0);
    expect(seed.every((e) => e.stage === "fixture" && e.token.startsWith("shellcheck:"))).toBe(true);
    expect(scan.fixturesDropped).toBe(seed.length);
  });

  it("5. records a finding disabled_rules names as dropped by it", () => {
    expect(scan.trail!.filter((e) => e.stage === "disabled-rule").map((e) => [e.token, e.file, e.lineStart])).toEqual([["hadolint:DL3007", "Dockerfile", 1]]);
    expect(scan.scanners.find((s) => s.scanner === "hadolint")!.stages?.rules).toBe(1);
  });

  it("9. writes the same selection and trail for a review of the same change", () => {
    expect(reviewed.status, reviewed.stderr).toBe(0);
    expect(review.trail?.length, "the review's scan.json has no trail").toBeGreaterThan(0);
    expect(review.selection).toEqual(scan.selection);
    expect(review.trail).toEqual(scan.trail);
  });
});
