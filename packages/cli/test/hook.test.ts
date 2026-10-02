// `openqodex hook check` and `hook install|uninstall`, run as the real
// built CLI on temp repos.
//
// Ways it could fail, written before the code:
//  1. A command that is not a push (git status, echo "git push", git pushx,
//     a commit message holding the word push) is treated as a push and
//     slows down or blocks every shell command.
//  2. A push inside a compound command, behind VAR=value, after git's global
//     options or after `cd dir &&` is missed.
//  3. Garbage on stdin, a missing field or an internal error exits non-zero
//     or prints something, which would break or confuse the push.
//  4. It prints permissionDecision "allow" or "ask", skipping the developer's
//     own permission prompt.
//  5. In warn mode with no review it denies, or says nothing.
//  6. After a finalized passing review of the same change it still warns or
//     denies.
//  7. With block_on_severity set and no review it does not deny.
//  8. OPENQODEX_SKIP=1 is ignored.
//  9. The git hook is not executable, lacks the marker, overwrites a foreign
//     hook, ignores core.hooksPath, or uninstall removes a hook that is not ours.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { cli, git, sandbox, type Sandbox } from "./init-helpers.js";

function check(s: Sandbox, command: string, opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: opts.cwd ?? s.repo });
  const r = cli(s, ["hook", "check"], { input, env: opts.env });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toMatch(/"permissionDecision":"(allow|ask)"/);
  return r;
}

const UNREVIEWED = "OpenQodex has not reviewed this change";

describe("hook check: which commands are pushes", () => {
  let s: Sandbox;
  beforeAll(() => {
    s = sandbox({ "README.md": "hello\n", "sub/file.txt": "x\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
  });

  const pushes = [
    "git push",
    "git push -u origin HEAD",
    "git -C sub push",
    "FOO=1 git push",
    "npm test && git push origin main",
    "cd sub && git push",
    "git --no-pager -c push.default=current push",
    "git status; git push",
  ];
  const notPushes = [
    "git status",
    "echo git push",
    'git commit -m "push"',
    "git pushx",
    'echo "git push"',
    "echo 'git push && x'",
    "",
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

  it("a push outside any git repository prints nothing and exits 0", () => {
    const r = check(s, "git push", { cwd: s.home });
    expect(r.stdout).toBe("");
  });

  it("OPENQODEX_SKIP=1 abstains and says so", () => {
    const r = check(s, "git push", { env: { OPENQODEX_SKIP: "1" } });
    expect(r.stdout).toContain("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    expect(r.stdout).not.toContain("permissionDecision");
  });
});

// Writes the files a finalized passing review of the current change leaves,
// through the core functions (the review command is built elsewhere).
async function finalizedPassingReview(s: Sandbox): Promise<void> {
  const change = await getChange({ repoRoot: s.repo, scope: {}, exclude: [] });
  const report: Report = {
    ...scanReport({
      change,
      scan: { candidates: [], scanners: [], fixturesDropped: 0, secretFingerprints: [] },
      config: DEFAULT_CONFIG,
    }),
    kind: "review",
  };
  const dir = openReportDir(s.repo, change.shortId);
  writeReportFiles(dir, { "report.json": JSON.stringify(report) });
  writeLatest(s.repo, { dir: relative(s.repo, dir), change_id: change.id, kind: "review", finalized: true, verdict: "passed" });
}

describe("hook check: decisions", () => {
  it("warn mode with no review abstains with the unreviewed message", () => {
    const s = sandbox();
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const r = check(s, "git push");
    expect(r.stdout).toContain(UNREVIEWED);
    expect(r.stdout).not.toContain("permissionDecision");
  });

  it("block_on_severity with no review denies", () => {
    const s = sandbox({ "README.md": "hello\n", ".openqodex.yaml": "review:\n  block_on_severity: major\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const out = JSON.parse(check(s, "git push").stdout);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("block_on_severity");
  });

  it("a finalized passing review of the same change prints nothing, in warn and block mode", async () => {
    for (const files of [{ "README.md": "hello\n" }, { "README.md": "hello\n", ".openqodex.yaml": "review:\n  block_on_severity: major\n" }]) {
      const s = sandbox(files);
      writeFileSync(join(s.repo, "README.md"), "changed\n");
      await finalizedPassingReview(s);
      expect(check(s, "git push").stdout).toBe("");
      // The change moves: the review no longer covers it.
      writeFileSync(join(s.repo, "README.md"), "changed again\n");
      expect(check(s, "git push").stdout).not.toBe("");
    }
  });
});

describe("hook install and uninstall", () => {
  it("writes an executable hook with the marker, and uninstall removes it", () => {
    const s = sandbox();
    const r = cli(s, ["hook", "install"]);
    expect(r.status, r.stderr).toBe(0);
    const hook = join(s.repo, ".git/hooks/pre-push");
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    const text = readFileSync(hook, "utf8");
    expect(text.startsWith("#!/bin/sh\n# openqodex pre-push hook")).toBe(true);
    expect(text).toContain(" scan");
    expect(cli(s, ["hook", "install"]).stdout).toContain("already installed");
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(existsSync(hook)).toBe(false);
  });

  it("refuses a foreign hook without --force, and uninstall leaves it alone", () => {
    const s = sandbox();
    const hook = join(s.repo, ".git/hooks/pre-push");
    writeFileSync(hook, "#!/bin/sh\necho mine\n");
    const r = cli(s, ["hook", "install"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("scan");
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
    cli(s, ["hook", "uninstall"]);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");

    expect(cli(s, ["hook", "install", "--force"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toContain("openqodex pre-push hook");
    expect(cli(s, ["hook", "uninstall"]).status).toBe(0);
    expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("honours core.hooksPath", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, "my-hooks"));
    git(s.repo, "config", "core.hooksPath", "my-hooks");
    expect(cli(s, ["hook", "install"]).status).toBe(0);
    expect(existsSync(join(s.repo, "my-hooks/pre-push"))).toBe(true);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(false);
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
