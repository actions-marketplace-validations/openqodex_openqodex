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
//  7. A step outside the tool-failure policy fails the job on a tool failure:
//     the scanner install on a config it cannot read.
//  8. The warning line breaks: the stderr extraction fails under pipefail on
//     empty input, or the tool's text writes a workflow command of its own (a
//     line break, `::`, `%` or a control character).
//  9. In a pull request the head's config hides findings (disabled_rules,
//     scanners.disable, severity_threshold): the config must come from the base.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

// The scan step run as GitHub runs a composite bash step (bash -eo pipefail),
// in a real repository, with `npx` standing in for the package download: it
// runs this build of the CLI. To keep the test offline and fast it leaves
// out doctor's --install and gives scan --no-install and --only sqllint.
function runStep(dir: string, env: Record<string, string>): { status: number | null; stdout: string; outputs: string } {
  const bin = join(here, "..", "dist", "bin.js");
  const shim = mkdtempSync(join(tmpdir(), "oq-npx-"));
  writeFileSync(
    join(shim, "npx"),
    [
      "#!/bin/sh",
      'shift; shift',
      'if [ "$1" = "doctor" ]; then shift; set -- doctor $(for a in "$@"; do [ "$a" = "--install" ] || printf "%s\\n" "$a"; done); fi',
      'if [ "$1" = "scan" ]; then shift; set -- scan --no-install --only sqllint "$@"; fi',
      `exec "${process.execPath}" "${bin}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shim, "npx"), 0o755);
  const temp = mkdtempSync(join(tmpdir(), "oq-runner-"));
  const outputs = join(temp, "output");
  writeFileSync(outputs, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step("Scan the change")!.run!], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: join(temp, "summary"), OPENQODEX_HOME: mkdtempSync(join(tmpdir(), "oq-action-home-")), OPENQODEX_VERSION: "0.0.0", BASE_SHA: "", BLOCK_ON_SEVERITY: "", CONFIG_FROM: "base", EVENT_NAME: "push", ...env },
  });
  return { status: r.status, stdout: r.stdout, outputs: readFileSync(outputs, "utf8") };
}

function gitRepo(): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "oq-action-step-"));
  const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", "-A");
  git("commit", "-qm", "Base");
  return { dir, git };
}

const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

describe("the scan step, run", () => {
  it("7. every step that runs openqodex sits under the tool-failure policy: an unreadable config warns and passes", () => {
    const runs = action.runs.steps.filter((s) => s.run?.includes("openqodex@"));
    expect(runs.map((s) => s.name)).toEqual(["Scan the change"]);
    const { dir } = gitRepo();
    writeFileSync(join(dir, ".openqodex.yaml"), "review: [\n");
    const r = runStep(dir, {});
    expect(r.status).toBe(0);
    expect(r.outputs).toContain("status=tool-failed");
    expect(r.stdout).toContain("::warning title=OpenQodex did not run::");
  });

  it("8. the reason line survives empty input and carries no workflow command of its own", () => {
    const script = step("Scan the change")!.run!;
    const fn = /last_line\(\) \{[\s\S]*?\n\s*\}/.exec(script)?.[0];
    expect(fn).toBeDefined();
    const file = join(mkdtempSync(join(tmpdir(), "oq-reason-")), "err");
    const reason = (text: string) => {
      writeFileSync(file, text);
      return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", `${fn}\nr="$(last_line '${file}')"; printf '%s' "$r"`], { encoding: "utf8" });
    };
    const empty = reason("");
    expect(empty.status).toBe(0);
    expect(empty.stdout).toBe("");
    const hostile = reason(`first\nbad %0A::error file=x::boom :::: x\u0007\r\n\n`);
    expect(hostile.status).toBe(0);
    expect(hostile.stdout).not.toMatch(/::|%0A/);
    expect([...hostile.stdout].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)).toBe(false);
    expect(hostile.stdout).toContain("%250A");
  });

  it("9. in a pull request the base branch's config decides, unless config-from is head", () => {
    const { dir, git } = gitRepo();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, ".openqodex.yaml"), "review:\n  disabled_rules: ['*']\nscanners:\n  disable: [sqllint]\n");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/x.sql"), SQL);
    git("add", "-A");
    git("commit", "-qm", "Hide everything");
    const pr = { EVENT_NAME: "pull_request", BASE_SHA: base, BLOCK_ON_SEVERITY: "info" };
    const fromBase = runStep(dir, pr);
    expect(fromBase.status).toBe(0);
    expect(fromBase.outputs).toContain("status=blocked");
    expect(runStep(dir, { ...pr, CONFIG_FROM: "head" }).outputs).toContain("status=passed");
  });
});
