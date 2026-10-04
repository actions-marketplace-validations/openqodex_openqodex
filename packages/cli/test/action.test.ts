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
// 12. A killed scan (137, 139, 143) is not a tool error, so fail-on-tool-error
//     misses it and no warning is written.
// 13. A push event scans an empty change: no base reaches the scan.
//  9. In a pull request the head's config hides findings (disabled_rules,
//     scanners.disable, severity_threshold): the config must come from the
//     base branch, and a failed fetch, a missing file or an odd branch name
//     falls back to the built-in defaults, never to the head's file.
// 10. A wrong config-from or block-on-severity input is taken silently.
// 11. A pull request adds a custom scanner that then runs in CI.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
const here = dirname(fileURLToPath(import.meta.url));
const action = parse(readFileSync(join(here, "..", "..", "..", "action.yml"), "utf8")) as { inputs: Record<string, { default?: string }>; outputs?: Record<string, { value: string }>; runs: { steps: Step[] } };
const step = (name: string) => action.runs.steps.find((s) => s.name === name);
const SCRIPT_PATH = join(here, "..", "..", "..", "scripts", "action-scan.sh");
const SCRIPT = readFileSync(SCRIPT_PATH, "utf8");

describe("the GitHub Action", () => {
  it("1, 3, 5. fails the job on exit 1, and on exit 2 only when fail-on-tool-error is true", () => {
    const fail = step("Fail on blocking findings or a tool failure");
    expect(fail?.if).toBe("steps.scan.outputs.exit-code == '1' || (steps.scan.outputs.exit-code == '2' && inputs.fail-on-tool-error == 'true')");
    expect(fail?.run).toContain("exit 1");
    expect(action.inputs["fail-on-tool-error"]?.default).toBe("false");
  });

  it("4. on exit 2 it writes a warning annotation, a job summary line and status tool-failed", () => {
    expect(step("Scan the change")?.run).toBe('bash "${GITHUB_ACTION_PATH}/scripts/action-scan.sh"');
    const run = SCRIPT;
    expect(run).toContain("::warning title=OpenQodex did not run::");
    expect(run).toContain("GITHUB_STEP_SUMMARY");
    for (const status of ["passed", "blocked", "tool-failed"]) expect(run).toContain(`status=${status}`);
    expect(action.outputs?.status?.value).toBe("${{ steps.scan.outputs.status }}");
  });

  it("6. passes the block-on-severity input to the scan, and the flag wins over the repository's config", () => {
    const scan = step("Scan the change");
    expect(scan?.env?.BLOCK_ON_SEVERITY).toBe("${{ inputs.block-on-severity }}");
    expect(SCRIPT).toContain("--block-on-severity");
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
    // The first line the step prints, as the job log shows it.
    const first = runStep(gitRepo().dir, {}).stdout.split("\n")[0];
    expect(first).toMatch(/^OpenQodex scanners only: .*not a review/);
  });
});

// The scan step run as GitHub runs a composite bash step (bash -eo pipefail),
// in a real repository, with `npx` standing in for the package download: it
// runs this build of the CLI. To keep the test offline and fast it leaves
// out doctor's --install and gives scan --no-install and, unless the test
// sets OQ_ALL_SCANNERS, --only sqllint.
function runStep(dir: string, env: Record<string, string>): { status: number | null; stdout: string; outputs: string } {
  const bin = join(here, "..", "dist", "bin.js");
  const shim = mkdtempSync(join(tmpdir(), "oq-npx-"));
  writeFileSync(
    join(shim, "npx"),
    [
      "#!/bin/sh",
      'shift; shift',
      'if [ "$1" = "doctor" ]; then shift; set -- doctor $(for a in "$@"; do [ "$a" = "--install" ] || printf "%s\\n" "$a"; done); fi',
      // OQ_KILL_SCAN: the scan process is killed (exit 137), as the runner's
      // out-of-memory killer would.
      'if [ "$1" = "scan" ] && [ -n "$OQ_KILL_SCAN" ]; then kill -9 $$; fi',
      'if [ "$1" = "scan" ] && [ -z "$OQ_ALL_SCANNERS" ]; then shift; set -- scan --no-install --only sqllint "$@"; fi',
      'if [ "$1" = "scan" ] && [ -n "$OQ_ALL_SCANNERS" ]; then shift; set -- scan --no-install "$@"; fi',
      `exec "${process.execPath}" "${bin}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(shim, "npx"), 0o755);
  const temp = mkdtempSync(join(tmpdir(), "oq-runner-"));
  const outputs = join(temp, "output");
  writeFileSync(outputs, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", SCRIPT_PATH], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: join(temp, "summary"), OPENQODEX_HOME: mkdtempSync(join(tmpdir(), "oq-action-home-")), OPENQODEX_VERSION: "0.0.0", BASE_SHA: "", BASE_REF: "", PUSH_BEFORE: "", DEFAULT_BRANCH: "", BLOCK_ON_SEVERITY: "", CONFIG_FROM: "base", EVENT_NAME: "push", ...env },
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
    const runs = action.runs.steps.filter((s) => s.run?.includes("openqodex@") || s.run?.includes("action-scan.sh"));
    expect(runs.map((s) => s.name)).toEqual(["Scan the change"]);
    const { dir } = gitRepo();
    writeFileSync(join(dir, ".openqodex.yaml"), "review: [\n");
    const r = runStep(dir, {});
    expect(r.status).toBe(0);
    expect(r.outputs).toContain("status=tool-failed");
    expect(r.stdout).toContain("::warning title=OpenQodex did not run::");
  });

  it("8. the reason line survives empty input and carries no workflow command of its own", () => {
    const script = SCRIPT;
    const fn = /last_line\(\) \{[\s\S]*?\n\}/.exec(script)?.[0];
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

  // A clone whose origin holds the base branch `main`, and a pull request
  // commit on top whose own config hides every finding.
  function pullRequest(baseConfig: string | null, headConfig: string): { dir: string; base: string } {
    const { dir: origin, git: og } = gitRepo();
    if (baseConfig !== null) {
      mkdirSync(join(origin, ".openqodex"));
      writeFileSync(join(origin, ".openqodex/config.yaml"), baseConfig);
      og("add", "-A");
      og("commit", "-qm", "Team config");
    }
    const dir = mkdtempSync(join(tmpdir(), "oq-action-clone-"));
    spawnSync("git", ["clone", "-q", origin, dir]);
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, ".openqodex.yaml"), headConfig);
    rmSync(join(dir, ".openqodex"), { recursive: true, force: true });
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/x.sql"), SQL);
    git("add", "-A");
    git("commit", "-qm", "Hide everything");
    git("update-ref", "-d", "refs/remotes/origin/main");
    return { dir, base };
  }
  const HIDE = "review:\n  disabled_rules: ['*']\nscanners:\n  disable: [sqllint]\n";

  it("9. in a pull request the base branch's config decides, unless config-from is head", () => {
    const { dir, base } = pullRequest("review:\n  severity_threshold: info\n", HIDE);
    const pr = { EVENT_NAME: "pull_request", BASE_SHA: base, BASE_REF: "main", BLOCK_ON_SEVERITY: "info" };
    const fromBase = runStep(dir, pr);
    expect(fromBase.status).toBe(0);
    expect(fromBase.outputs).toContain("status=blocked");
    expect(runStep(dir, { ...pr, CONFIG_FROM: "head" }).outputs).toContain("status=passed");
  });

  it("9. a base with no config, a failed fetch or an odd branch name gives the built-in defaults, never the head's file", () => {
    const { dir, base } = pullRequest(null, HIDE);
    const pr = { EVENT_NAME: "pull_request", BASE_SHA: base, BASE_REF: "main", BLOCK_ON_SEVERITY: "info" };
    expect(runStep(dir, pr).outputs).toContain("status=blocked");
    const missing = runStep(dir, { ...pr, BASE_REF: "no-such-branch" });
    expect(missing.outputs).toContain("status=blocked");
    expect(missing.stdout).toContain("::warning title=OpenQodex config::could not fetch the base branch");
    for (const odd of ["-x", "main;rm", "a b", "$(id)"]) {
      const r = runStep(dir, { ...pr, BASE_REF: odd });
      expect(r.outputs, odd).toContain("status=blocked");
      expect(r.stdout, odd).toContain("not a plain branch name");
    }
  }, 30_000);

  it("10. a wrong config-from or block-on-severity fails the step with one line", () => {
    const { dir } = gitRepo();
    for (const env of [{ CONFIG_FROM: "both" }, { BLOCK_ON_SEVERITY: "high" }]) {
      const r = runStep(dir, env);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/::error title=OpenQodex input::/);
    }
  });

  it("11. a custom scanner the pull request adds never runs in CI, whichever config is used", () => {
    const marker = join(mkdtempSync(join(tmpdir(), "oq-custom-")), "ran");
    const custom = `scanners:\n  custom:\n    - source: https://github.com/example/planted\n      run: touch ${marker} {report} {target}\n`;
    const { dir, base } = pullRequest(null, custom);
    for (const from of ["base", "head"]) {
      const r = runStep(dir, { EVENT_NAME: "pull_request", BASE_SHA: base, BASE_REF: "main", CONFIG_FROM: from, OQ_ALL_SCANNERS: "1" });
      expect(r.outputs, from).toMatch(/status=(passed|blocked)/);
      expect(existsSync(marker), from).toBe(false);
    }
  });

  it("12. a scan killed by a signal is a tool error: exit-code 2, status tool-failed and the warning", () => {
    const { dir } = gitRepo();
    const r = runStep(dir, { OQ_KILL_SCAN: "1" });
    expect(r.status).toBe(0);
    expect(r.outputs).toContain("exit-code=2");
    expect(r.outputs).toContain("status=tool-failed");
    expect(r.stdout).toContain("::warning title=OpenQodex did not run::");
  });

  // A clone of a remote holding main, with a pushed commit that adds the SQL
  // file, checked out detached as the runner does.
  function pushedClone(onBranch: boolean): { dir: string; before: string } {
    const { dir: origin } = gitRepo();
    const dir = mkdtempSync(join(tmpdir(), "oq-action-push-"));
    spawnSync("git", ["clone", "-q", origin, dir]);
    const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: dir, encoding: "utf8" }).stdout.trim();
    const before = git("rev-parse", "HEAD");
    if (onBranch) git("checkout", "-q", "-b", "feature");
    mkdirSync(join(dir, "db"));
    writeFileSync(join(dir, "db/x.sql"), SQL);
    git("add", "-A");
    git("commit", "-qm", "Pushed");
    git("checkout", "-q", "--detach");
    // actions/checkout sets no origin/HEAD, so the CLI has no default base.
    git("remote", "set-head", "origin", "-d");
    return { dir, before };
  }

  it("13. a push event scans the pushed commits from the event's previous commit", () => {
    const { dir, before } = pushedClone(false);
    const r = runStep(dir, { EVENT_NAME: "push", PUSH_BEFORE: before, BLOCK_ON_SEVERITY: "info" });
    expect(r.outputs).toContain("status=blocked");
  });

  it("13. a push that creates a branch scans from the merge base with the default branch", () => {
    const { dir } = pushedClone(true);
    const r = runStep(dir, { EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40), DEFAULT_BRANCH: "main", BLOCK_ON_SEVERITY: "info" });
    expect(r.outputs).toContain("status=blocked");
  });

  it("13. an event with no usable base says so in its first line", () => {
    const { dir } = gitRepo();
    for (const env of [{ EVENT_NAME: "workflow_dispatch" }, { EVENT_NAME: "push", PUSH_BEFORE: "not-a-sha" }]) {
      const first = runStep(dir, env).stdout.split("\n")[0];
      expect(first, env.EVENT_NAME).toMatch(/^OpenQodex scanners only: .*not a review.*no base/);
    }
  });
});
