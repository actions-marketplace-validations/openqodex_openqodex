// The GitHub Action (action.yml at the root) runs the scanners only.
//
// Ways it could fail, written before the code:
//  1. A tool failure (exit 2) fails the job.
//  2. Its output does not say, first, that it is a scanner run and not a review.
//  3. Findings at or above block_on_severity (exit 1) no longer fail the job.
//  4. A tool failure passes silently: no warning annotation, no job summary
//     line, no status output.
//  5. A team cannot make a tool failure fail the job.
//  6. The pull request's own config can weaken the gate a team set in the
//     workflow: the block-on-severity input must win over the file.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
const here = dirname(fileURLToPath(import.meta.url));
const action = parse(readFileSync(join(here, "..", "..", "..", "action.yml"), "utf8")) as { inputs: Record<string, { default?: string }>; outputs?: Record<string, { value: string }>; runs: { steps: Step[] } };
const step = (name: string) => action.runs.steps.find((s) => s.name === name);

describe("the GitHub Action", () => {
  it("1, 3, 5. fails the job on exit 1, and on exit 2 only when fail-on-tool-error is true", () => {
    const fail = step("Fail on blocking findings or a tool failure");
    expect(fail?.if).toBe("steps.scan.outputs.exit-code == '1' || (steps.scan.outputs.exit-code == '2' && inputs.fail-on-tool-error == 'true')");
    expect(fail?.run).toContain("exit 1");
    expect(action.inputs["fail-on-tool-error"]?.default).toBe("false");
  });

  it("4. on exit 2 it writes a warning annotation, a job summary line and status tool-failed", () => {
    const run = step("Scan the change")?.run ?? "";
    expect(run).toContain("::warning title=OpenQodex did not run::");
    expect(run).toContain("GITHUB_STEP_SUMMARY");
    for (const status of ["passed", "blocked", "tool-failed"]) expect(run).toContain(`status=${status}`);
    expect(action.outputs?.status?.value).toBe("${{ steps.scan.outputs.status }}");
  });

  it("6. passes the block-on-severity input to the scan, and the flag wins over the repository's config", () => {
    const scan = step("Scan the change");
    expect(scan?.env?.BLOCK_ON_SEVERITY).toBe("${{ inputs.block-on-severity }}");
    expect(scan?.run).toContain("--block-on-severity");
    // The flag against the built CLI: the file says nothing blocks below critical, the flag says minor.
    const dir = mkdtempSync(join(tmpdir(), "oq-action-"));
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, ".openqodex.yaml"), "review:\n  block_on_severity: critical\n");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git("add", "-A");
    git("commit", "-qm", "Base");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/x.sql"), "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n");
    const bin = join(here, "..", "dist", "bin.js");
    const scanWith = (...extra: string[]) => spawnSync(process.execPath, [bin, "scan", "--only", "sqllint", "--no-install", ...extra], { cwd: dir, encoding: "utf8", env: { ...process.env, OPENQODEX_HOME: mkdtempSync(join(tmpdir(), "oq-action-home-")) } });
    expect(scanWith().status).toBe(0);
    expect(scanWith("--block-on-severity", "info").status).toBe(1);
  });

  it("2. says first that it runs the scanners only and is not a review", () => {
    const scan = step("Scan the change");
    const first = scan?.run?.split("\n").find((l) => l.trim() !== "");
    expect(first).toMatch(/^echo "OpenQodex scanners only: .*not a review/);
  });
});
