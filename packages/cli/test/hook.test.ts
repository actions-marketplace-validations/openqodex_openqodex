// `openqodex hook check` and `hook install|uninstall`, run as the real
// built CLI on temp repos.
//
// Ways it could fail, written before the code:
//  1. A command that is not a push (echo "git push", a here-document body,
//     git pushx, a commit message holding the word push) is treated as one.
//  2. A real push is missed: inside a compound command, a subshell, a
//     command substitution, an if block, behind VAR=value, after git's
//     global options, through a git alias, with a redirect attached.
//  3. The wrong repo is checked (-C, --git-dir, --work-tree, GIT_DIR, cd,
//     a cd inside parentheses leaking out), or only the first of two pushes.
//  4. Garbage on stdin, stdin left open, or a broken launcher exits non-zero,
//     hangs, or prints something.
//  5. It prints permissionDecision "allow" or "ask".
//  6. Warn mode denies; block mode with no review does not deny; a passing
//     review of the same change still warns.
//  7. OPENQODEX_SKIP=1 is ignored.
//  8. The git hook can block a push because the tool failed to start, lacks
//     the marker, overwrites a foreign hook or an earlier backup, ignores
//     core.hooksPath, or uninstall removes a hook that is not ours or that
//     the developer edited.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  DEFAULT_CONFIG,
  getChange,
  openReportDir,
  scanReport,
  writeLatest,
  writeReportFiles,
  type Report,
} from "@openqodex/core";
import { beforeAll, describe, expect, it } from "vitest";
import { BIN, cli, env, git, sandbox, type Sandbox } from "./init-helpers.js";

function check(s: Sandbox, command: string, opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: opts.cwd ?? s.repo });
  const r = cli(s, ["hook", "check"], { input, env: opts.env });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toMatch(/"permissionDecision":"(allow|ask)"/);
  return r;
}

const UNREVIEWED = "OpenQodex has not reviewed this change";
const BLOCK = ".openqodex.yaml";
const BLOCK_YAML = "review:\n  block_on_severity: major\n";

describe("hook check: which commands are pushes", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = sandbox({ "README.md": "hello\n", "sub/file.txt": "x\n" });
    git(s.repo, "config", "alias.ship", "push origin HEAD");
    writeFileSync(join(s.repo, "README.md"), "changed\n");
  });

  const pushes = [
    "git push",
    "git -C sub push",
    "git -Csub push",
    "FOO=1 git push",
    "npm test && git push origin main",
    "cd sub && git push",
    "git --no-pager -c push.default=current push",
    "git -c alias.publish=push publish",
    "git ship",
    "echo `git push`",
    'echo "$(git push)"',
    "git push>/tmp/openqodex-test-log",
    "if true; then git push; fi",
    "for r in a; do git push; done",
    "{ git push; }",
    "! git push",
    "cat <<EOF\nhello\nEOF\ngit push",
  ];
  const notPushes = [
    "git status",
    "echo git push",
    'git commit -m "push"',
    "git pushx",
    'echo "git push"',
    "echo 'git push && x'",
    "cat <<'EOF'\ngit push\nEOF",
    "git -c alias.publish=status publish",
  ];

  it.each(pushes)("treats %j as a push", (command) => {
    expect(check(s, command).stdout).toContain(UNREVIEWED);
  });

  it.each(notPushes)("treats %j as not a push and prints nothing", (command) => {
    expect(check(s, command).stdout).toBe("");
  });

  it("garbage on stdin prints nothing and exits 0", () => {
    const r = cli(s, ["hook", "check"], { input: "not json at all" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("stdin left open ends within the deadline, exit 0, nothing printed", async () => {
    const child = spawn(process.execPath, [BIN, "hook", "check"], { cwd: s.repo, env: env(s) });
    child.stdin.write(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo }));
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.destroy();
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("OPENQODEX_SKIP=1 abstains and says so", () => {
    const r = check(s, "git push", { env: { OPENQODEX_SKIP: "1" } });
    expect(r.stdout).toContain("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    expect(r.stdout).not.toContain("permissionDecision");
  });
});

// Writes the files a finalized passing review of the current change leaves,
// through the core functions (the review command is built elsewhere).
async function finalizedPassingReview(repo: string): Promise<void> {
  const change = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
  const report: Report = {
    ...scanReport({
      change,
      scan: { candidates: [], scanners: [], fixturesDropped: 0, secretFingerprints: [] },
      config: DEFAULT_CONFIG,
    }),
    kind: "review",
  };
  const dir = openReportDir(repo, change.shortId);
  writeReportFiles(dir, { "report.json": JSON.stringify(report) });
  writeLatest(repo, { dir: relative(repo, dir), change_id: change.id, kind: "review", finalized: true, verdict: "passed" });
}

function blockingRepo(root: string, name: string): string {
  const repo = join(root, name);
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, BLOCK), BLOCK_YAML);
  git(repo, "add", "-A");
  git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "start");
  writeFileSync(join(repo, "a.txt"), "change\n");
  return repo;
}

function decision(stdout: string): string | undefined {
  return stdout === "" ? undefined : (JSON.parse(stdout) as { hookSpecificOutput: { permissionDecision?: string } }).hookSpecificOutput.permissionDecision;
}

describe("hook check: decisions", () => {
  it("warn mode with no review abstains with the unreviewed message", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const r = check(s, "git push");
    expect(r.stdout).toContain(UNREVIEWED);
    expect(decision(r.stdout)).toBeUndefined();
  });

  it("block mode with no review denies", () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(decision(check(s, "git push").stdout)).toBe("deny");
  });

  it("a finalized passing review of the same change prints nothing, and stops covering it once the change moves", async () => {
    const s = sandbox({ "README.md": "hello\n", [BLOCK]: BLOCK_YAML });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    await finalizedPassingReview(s.repo);
    expect(check(s, "git push").stdout).toBe("");
    writeFileSync(join(s.repo, "README.md"), "changed again\n");
    expect(decision(check(s, "git push").stdout)).toBe("deny");
  });

  it("checks the repo each push names, and every push on the line", async () => {
    const s = sandbox();
    const a = blockingRepo(s.root, "a");
    blockingRepo(s.root, "b");
    await finalizedPassingReview(a);
    const at = (cwd: string, command: string) => check(s, command, { cwd }).stdout;
    expect(at(s.root, "git -C a push")).toBe("");
    expect(decision(at(s.root, "git -C b push"))).toBe("deny");
    expect(decision(at(s.root, "git -C a push && git -C b push"))).toBe("deny");
    expect(decision(at(s.root, "(cd a); cd b && git push"))).toBe("deny");
    expect(at(s.root, "(cd b); cd a && git push")).toBe("");
    expect(decision(at(a, "git --git-dir=../b/.git --work-tree=../b push"))).toBe("deny");
    expect(decision(at(a, "GIT_DIR=../b/.git GIT_WORK_TREE=../b git push"))).toBe("deny");
  });
});

describe("hook check through the launcher", () => {
  it("exits 0 with one repair line when no node can be found or the CLI cannot start", () => {
    const s = sandbox();
    expect(cli(s, ["init", "--yes", "--agent", "claude-code"]).status).toBe(0);
    const launcher = join(s.oqHome, "bin/openqodex");
    const text = readFileSync(launcher, "utf8");
    const emptyPath = mkdtempSync(join(tmpdir(), "oq empty path "));
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo });

    writeFileSync(launcher, text.replace(/^node=.*$/m, "node='/nonexistent/node'"));
    const noNode = spawnSync("/bin/sh", [launcher, "hook", "check"], { input, encoding: "utf8", env: { ...env(s), PATH: emptyPath } });
    expect(noNode.status).toBe(0);
    expect(noNode.stdout).toBe("");
    expect(noNode.stderr).toContain("openqodex");

    writeFileSync(launcher, text.replace(/dist\/bin\.js/, "dist/missing.js"));
    const broken = spawnSync("/bin/sh", [launcher, "hook", "check"], { input, encoding: "utf8", env: env(s) });
    expect(broken.status).toBe(0);
    expect(broken.stderr).toContain("openqodex");
  });
});

describe("hook install and uninstall", () => {
  it("installs the runtime and launcher when missing, and the hook calls the launcher, not npx", () => {
    const s = sandbox();
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const hook = join(s.repo, ".git/hooks/pre-push");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    const text = readFileSync(hook, "utf8");
    expect(text).not.toContain("npx");
    expect(text).toContain(join(s.oqHome, "bin/openqodex"));
    expect(existsSync(join(s.oqHome, "bin/openqodex"))).toBe(true);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(existsSync(hook)).toBe(false);
  });

  it("a scan that fails to run never blocks the push", () => {
    const s = sandbox();
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    // The runtime copy is gone: the scan cannot start at all.
    rmSync(join(s.oqHome, "runtime"), { recursive: true });
    const r = spawnSync(join(s.repo, ".git/hooks/pre-push"), [], { cwd: s.repo, env: env(s), input: "" });
    expect(r.status).toBe(0);
  });

  it("refuses a foreign hook without --force; --force twice keeps both earlier hooks", () => {
    const s = sandbox();
    const hook = join(s.repo, ".git/hooks/pre-push");
    writeFileSync(hook, "#!/bin/sh\necho first\n");
    expect(cli(s, ["hook", "install"]).status).toBe(2);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho first\n");

    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho first\n");
    writeFileSync(hook, "#!/bin/sh\necho second\n");
    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    writeFileSync(hook, "#!/bin/sh\necho third\n");
    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    const kept = readdirSync(join(s.repo, ".git/hooks"))
      .filter((n) => n.startsWith("pre-push.openqodex.bak"))
      .map((n) => readFileSync(join(s.repo, ".git/hooks", n), "utf8"));
    expect(kept.sort()).toEqual(["#!/bin/sh\necho second\n", "#!/bin/sh\necho third\n"]);
  });

  it("uninstall leaves a hook the developer edited after install", () => {
    const s = sandbox();
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    const hook = join(s.repo, ".git/hooks/pre-push");
    const edited = `${readFileSync(hook, "utf8")}echo my own check\n`;
    writeFileSync(hook, edited);
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe(edited);
  });

  it("honours core.hooksPath", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, "my-hooks"));
    git(s.repo, "config", "core.hooksPath", "my-hooks");
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    expect(existsSync(join(s.repo, "my-hooks/pre-push"))).toBe(true);
  });

  it("prints the line to add for husky and writes nothing", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, ".husky"));
    const r = cli(s, ["hook", "install"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("husky");
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
  });
});
