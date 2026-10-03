// Links in the repo's own state (`.openqodex/` and the root
// `.openqodex.yaml`), run as the real built CLI on temp repos. Whoever wrote
// the commit or the work tree controls those paths.
//
// Ways it could fail, written before the code:
//  1. init reads a root .openqodex.yaml that links to an endless file and
//     never ends.
//  2. init --uninstall puts the Day 0 .gitignore back through a link at the
//     file, or through a linked .openqodex folder, and so writes outside the
//     repo.
//  3. report saves its issue next to a .gitignore that is a dangling link,
//     and creates the link's target outside the repo.
//  4. report --send-last reads last-report.json through a linked .openqodex.
//  5. hook check reads a config that links to an endless file and never
//     ends, or reads the config through a linked .openqodex and lets that
//     outside file decide the push.
//  6. hook pre-push, scanning in place, reads a root .openqodex.yaml that
//     links to an endless file and never ends.
//  7. review --finalize reads run.json in the run folder through a link to
//     an endless file and never ends.
//  8. The line printed for a hook manager (husky, lefthook) blocks a push
//     when the tool itself fails (exit 2).
// Cases that the earlier checks already refuse before any read are named in
// the report of the change, not repeated here: a linked .openqodex in hook
// pre-push and review --finalize, a linked run folder, a linked
// last-report.json, and a linked .openqodex when report saves its issue.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BIN, cli, env, sandbox, tree, type Sandbox } from "./init-helpers.js";

const BOUNDED = 20_000;

// The real CLI with a 20 second limit: an endless read shows as status null.
function bounded(s: Sandbox, args: string[], input = "") {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: s.repo, env: env(s), input, encoding: "utf8", timeout: BOUNDED });
}

function outside(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-links-outside-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const pushInput = (s: Sandbox): string => JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: s.repo });

describe("init and uninstall with links in the repo state", () => {
  it("init ends with one line when the root .openqodex.yaml links to an endless file", () => {
    const s = sandbox({ "README.md": "hello\n" });
    symlinkSync("/dev/zero", join(s.repo, ".openqodex.yaml"));
    const r = bounded(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is a symbolic link");
  });

  // A repo from Day 0: the folder's .gitignore held "*", and init migrates it.
  function migrated(): { s: Sandbox; current: string } {
    const s = sandbox({ "README.md": "hello\n", ".openqodex/config.yaml": "review: {}\n", ".openqodex/custom-instructions.md": "Ours.\n" });
    writeFileSync(join(s.repo, ".openqodex/.gitignore"), "*\n");
    const r = cli(s, ["init", "--yes", "--hook", "none", "--agent", "claude-code"]);
    expect(r.status, r.stderr).toBe(0);
    return { s, current: readFileSync(join(s.repo, ".openqodex/.gitignore"), "utf8") };
  }

  it("uninstall never restores the Day 0 .gitignore through a link at the file", () => {
    const { s, current } = migrated();
    const away = outside({ ".gitignore": current });
    const before = tree(away);
    renameSync(join(s.repo, ".openqodex/.gitignore"), join(s.root, "moved-gitignore"));
    symlinkSync(join(away, ".gitignore"), join(s.repo, ".openqodex/.gitignore"));
    bounded(s, ["init", "--uninstall", "--yes"]);
    expect(tree(away)).toEqual(before);
  });

  it("uninstall never restores the Day 0 .gitignore through a linked .openqodex folder", () => {
    const { s, current } = migrated();
    const away = outside({ ".gitignore": current, "config.yaml": "review: {}\n", "custom-instructions.md": "Ours.\n" });
    const before = tree(away);
    renameSync(join(s.repo, ".openqodex"), join(s.root, "moved-state"));
    symlinkSync(away, join(s.repo, ".openqodex"));
    bounded(s, ["init", "--uninstall", "--yes"]);
    expect(tree(away)).toEqual(before);
  });
});

describe("report with links in the repo state", () => {
  it("report never creates the target of a dangling .gitignore link when it saves its issue", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const away = outside({});
    mkdirSync(join(s.repo, ".openqodex"));
    symlinkSync(join(away, "made-by-openqodex"), join(s.repo, ".openqodex/.gitignore"));
    bounded(s, ["report", "the scan said nothing"]);
    expect(existsSync(join(away, "made-by-openqodex"))).toBe(false);
  });

  it("report --send-last refuses a last-report.json reached through a linked .openqodex folder", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const away = outside({ "last-report.json": "{}\n" });
    symlinkSync(away, join(s.repo, ".openqodex"));
    const r = bounded(s, ["report", "--send-last"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is a symbolic link");
  });
});

describe("the push gates with links in the repo state", () => {
  it("hook check ends when .openqodex/config.yaml links to an endless file", () => {
    const s = sandbox({ "README.md": "hello\n" });
    mkdirSync(join(s.repo, ".openqodex"));
    symlinkSync("/dev/zero", join(s.repo, ".openqodex/config.yaml"));
    const r = bounded(s, ["hook", "check"], pushInput(s));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("is a symbolic link");
  });

  it("hook check never lets a config reached through a linked .openqodex folder decide the push", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const away = outside({ "config.yaml": "review:\n  block_on_severity: critical\n" });
    symlinkSync(away, join(s.repo, ".openqodex"));
    const r = bounded(s, ["hook", "check"], pushInput(s));
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('"permissionDecision":"deny"');
    expect(r.stderr).toContain("is a symbolic link");
  });

  it("hook pre-push ends with one line when the root .openqodex.yaml links to an endless file", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    symlinkSync("/dev/zero", join(s.repo, ".openqodex.yaml"));
    const r = bounded(s, ["hook", "pre-push"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is a symbolic link");
  });

  it("the line printed for husky lets the push through when the tool itself fails", () => {
    const s = sandbox();
    mkdirSync(join(s.repo, ".husky"));
    const r = cli(s, ["hook", "install"]);
    const line = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("npx -y openqodex@"));
    expect(line).toBeDefined();
    // The same line with the built CLI in place of the published one, run
    // outside any repository, where hook pre-push fails with exit 2.
    const local = line!.replace(/^npx -y openqodex@\S+/, `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)}`);
    const away = mkdtempSync(join(tmpdir(), "oq-links-norepo-"));
    const failed = spawnSync("sh", ["-c", local], { cwd: away, env: env(s), input: "", encoding: "utf8", timeout: BOUNDED });
    expect(failed.stderr).toContain("run it inside a git repository");
    expect(failed.status).toBe(0);
  });
});

describe("finalize with links in the run folder", () => {
  it("review --finalize ends with one line when run.json links to an endless file", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(cli(s, ["review", "--agent", "--no-install"]).status).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const findings = { version: 1, change_id: latest.change_id, summary: "Checked.", reviewer: "subagent", findings: [] };
    writeFileSync(join(s.repo, latest.dir, "agent-findings.json"), JSON.stringify(findings));
    renameSync(join(s.repo, latest.dir, "run.json"), join(s.root, "moved-run.json"));
    symlinkSync("/dev/zero", join(s.repo, latest.dir, "run.json"));
    const r = bounded(s, ["review", "--finalize"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("is a symbolic link");
  });
});
