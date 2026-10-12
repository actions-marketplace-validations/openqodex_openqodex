// A review stopped at its time cap still says what the scanners found (issue
// 147), end to end: the built CLI on the demo change with the real scanners.
// The model provider is the one stand-in: a Claude Code that passes the
// version and login checks, then never answers the review. The demo change
// has no sqllint candidate, so the case adds the admin SQL function the
// issue's run had. As in the timings case, the two scanners that read live
// data are skipped.
//
// Ways it could fail, written before the code:
//  1. report.json of a review stopped at the cap lists no scanner candidate
//     under not_reviewed, while scan.json beside it holds them.
//  2. A candidate is listed without what the developer needs to act on it:
//     its file, line, rule id, scanner or message.
//  3. report.md, report.sarif or the terminal receipt leaves the candidates
//     out, so only report.json says what the scanners found.
//  4. The candidates read as a review: the verdict is not incomplete, the
//     exit code is not 2 (a listed candidate at block_on_severity makes it 1),
//     the receipt does not open with "Review incomplete", the SARIF run says
//     it completed, report.html counts them as findings, the push gate's
//     record holds a verdict, or the push gate denies the push or passes it
//     as reviewed instead of saying, as for any incomplete review, that the
//     review was incomplete and does not block.
//  5. Listing the candidates shows the demo's secret, which the gitleaks
//     candidate is about.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Candidate, Report } from "@openqodex/core";
import "./global-setup.js";
import { demo, generatedSecret, readJson, reportDir, run, writeConfig } from "./support.js";
import type { Result } from "./support.js";
import { removeTempDirs, tempDir } from "../temp-dirs.mjs";

afterAll(removeTempDirs);

// The admin function sqllint flags: it keeps the default execute grant for every role.
const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";
const CAP = "the reviewer timed out and was stopped at the 1 second cap; pass --timeout <seconds> to allow more";

// A Claude Code that is installed and logged in, and that reads the brief
// and never answers: the run stops it at the cap.
function silentReviewer(): string {
  const folder = tempDir("oq-e2e-silent-");
  const script = [
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
    "process.stdin.resume();",
    "setInterval(() => {}, 60_000);",
  ].join("\n");
  writeFileSync(join(folder, "claude"), `#!${process.execPath}\n${script}\n`);
  chmodSync(join(folder, "claude"), 0o755);
  return folder;
}

const location = (c: Candidate) => (c.lineEnd > c.lineStart ? `${c.filePath}:${c.lineStart}-${c.lineEnd}` : `${c.filePath}:${c.lineStart}`);
// A message's first line as every output prints it: runs of white space as one space.
const firstLine = (text: string) => (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().replace(/\s+/g, " ");

type SarifResult = { ruleId: string; message: { text: string }; locations: { physicalLocation: { artifactLocation: { uri: string }; region: { startLine: number } } }[]; properties: Record<string, unknown> };
type Sarif = { runs: { tool: { driver: { name: string } }; results: SarifResult[]; invocations?: { executionSuccessful: boolean }[] }[] };

describe("a review stopped at the time cap", () => {
  let dir: string;
  let review: Result;
  let folder: string;
  let report: Report;
  let candidates: Candidate[];
  let gate: Result;
  beforeAll(() => {
    dir = demo("incomplete-report");
    // The unchecked candidates meet the block severity: they must still not block.
    writeConfig(dir, "review:\n  block_on_severity: major\n");
    mkdirSync(join(dir, "db"), { recursive: true });
    writeFileSync(join(dir, "db/admin.sql"), SQL);
    const path = [silentReviewer(), dirname(process.execPath), process.env.PATH].join(delimiter);
    review = run("incomplete-report-review", dir, ["review", "--reviewer", "claude", "--timeout", "1", "--skip", "semgrep,osv-scanner", "--no-color"], { env: { PATH: path, CLAUDECODE: undefined } });
    folder = reportDir(dir);
    report = readJson<Report>(join(folder, "report.json"));
    candidates = readJson<{ candidates: Candidate[] }>(join(folder, "scan.json")).candidates;
    // The agent push gate, as Claude Code calls it before `git push`.
    gate = run("incomplete-report-push-gate", dir, ["hook", "check"], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: dir }) });
  }, 600_000);

  it("4. is incomplete and exits 2 although unchecked candidates meet block_on_severity, says it timed out, counts no finding and records no verdict", () => {
    expect(report.block_on_severity).toBe("major");
    expect(report.not_reviewed.some((c) => c.reviewSeverity === "major")).toBe(true);
    expect(review.status, review.stderr).toBe(2);
    expect(report.verdict).toBe("incomplete");
    expect(report.completion?.missing).toContain(CAP);
    expect(review.stdout.split("\n")[0]).toBe("Review incomplete: this is not a review of the change");
    const html = readFileSync(join(folder, "report.html"), "utf8");
    expect(html).toContain('<span class="counts">0 findings</span>');
    expect(html).toContain("Unchecked scanner candidates, not a review");
    expect(readJson<{ verdict: unknown; finalized: boolean }>(join(dir, ".openqodex/latest.json"))).toMatchObject({ verdict: null, finalized: false });
  });

  it("4. the push gate treats it as any incomplete review: it does not deny, and says the review was incomplete", () => {
    expect(gate.status, gate.stderr).toBe(0);
    const out = JSON.parse(gate.stdout) as { hookSpecificOutput: { permissionDecision?: string; additionalContext?: string } };
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain(`the last review of this change was incomplete (${CAP}), so it does not block`);
  });

  it("1, 2. report.json lists every scanner candidate under not_reviewed, the sqllint one with its file, line, rule, scanner and message", () => {
    expect(candidates.map((c) => c.source)).toEqual(expect.arrayContaining(["sqllint", "gitleaks", "hadolint", "shellcheck"]));
    expect(report.not_reviewed.map((c) => c.id).sort()).toEqual(candidates.map((c) => c.id).sort());
    const sql = report.not_reviewed.find((c) => c.source === "sqllint");
    expect(sql).toMatchObject({ filePath: "db/admin.sql", ruleId: "function-default-public-execute", token: "sqllint:function-default-public-execute" });
    expect(sql!.lineStart).toBeGreaterThanOrEqual(1);
    expect(sql!.message.trim()).not.toBe("");
    expect(report.findings).toEqual([]);
  });

  it("2, 3. report.md lists each candidate with its place, rule, scanner and message", () => {
    // The markdown escapes punctuation with a backslash; the reader sees it without.
    const md = readFileSync(join(folder, "report.md"), "utf8").replace(/\\/g, "");
    const sections = md.split("\n### ");
    for (const c of candidates) {
      const section = sections.find((s) => s.startsWith(`${c.id} at ${location(c)}: `));
      expect(section, `report.md has no section for ${c.id}`).toBeDefined();
      expect(section).toContain(c.ruleId);
      expect(section).toContain(`Scanner:** ${c.source}`);
      expect(section).toContain(firstLine(c.message).replace(/\\/g, ""));
    }
  });

  it("2, 3. report.sarif holds each candidate in its scanner's run, and the review's run says it did not complete", () => {
    const sarif = readJson<Sarif>(join(folder, "report.sarif"));
    expect(sarif.runs[0]!.tool.driver.name).toBe("openqodex");
    expect(sarif.runs[0]!.invocations?.[0]?.executionSuccessful).toBe(false);
    for (const c of candidates) {
      const results = sarif.runs.filter((r) => r.tool.driver.name === c.source).flatMap((r) => r.results);
      const r = results.find((x) => x.properties.candidate === c.id);
      expect(r, `report.sarif has no result for ${c.id}`).toBeDefined();
      expect(r).toMatchObject({ ruleId: c.ruleId, message: { text: c.message }, properties: { not_reviewed: true } });
      expect(r!.locations[0]!.physicalLocation.artifactLocation.uri).toBe(c.filePath.split("/").map(encodeURIComponent).join("/"));
      expect(r!.locations[0]!.physicalLocation.region.startLine).toBe(c.lineStart);
    }
  });

  it("2, 3. the terminal receipt lists each candidate on one line with its place, scanner, rule and message", () => {
    const lines = review.stdout.split("\n");
    for (const c of candidates) {
      const line = lines.find((l) => l.startsWith(`${c.id} at ${location(c)}: `));
      expect(line, `the receipt has no line for ${c.id}`).toBeDefined();
      expect(line).toContain(`${c.source} ${c.ruleId}`);
      expect(line).toContain(firstLine(c.message));
    }
  });

  it("5. no output shows the demo's secret", () => {
    const secret = generatedSecret(dir);
    for (const name of ["report.json", "report.md", "report.sarif", "report.html"]) expect(readFileSync(join(folder, name), "utf8"), name).not.toContain(secret);
    expect(review.stdout).not.toContain(secret);
    expect(review.stderr).not.toContain(secret);
  });
});
