// The feedback offer, run as real subprocesses of the built dist/bin.js in
// real temp git repos. Build first (`pnpm build`). Every run gets a PATH that
// holds only git and a recorder standing in for `open` and `xdg-open` (a test
// harness for the browser, an external command): `gh` is never on it, so no
// run can create a real issue, and the recorder shows whether anything tried
// to leave the machine.
//
// Ways the feedback offer could fail, written before the code:
// 1. The CLI's own failure exits with something other than 2, or prints an
//    issue that differs from the documented text, or drops the two choices
//    or the line that says how to send it later.
// 2. The issue body carries a path, the repo's name, a changed file's name,
//    the user's name or a key-shaped token from an error line or from the
//    developer's own words.
// 3. A scanner that ended `failed` prints no offer, or prints it twice; a
//    scanner that is only not installed prints one.
// 4. A run without a terminal sends something (opens the browser) without
//    the developer choosing 1.
// 5. `report --send-last` sends a title or body that differs from the one
//    shown, or sends nothing.
// 6. `hook check` prints the offer, so the agent's push gate gets noise, or
//    exits other than 0.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(cliRoot, "dist", "bin.js");
const VERSION = (JSON.parse(readFileSync(join(cliRoot, "package.json"), "utf8")) as { version: string }).version;
const OS = ({ darwin: "macOS", linux: "Linux", win32: "Windows" } as Record<string, string>)[process.platform] ?? process.platform;
const ENVIRONMENT = `Environment: ${OS}, ${process.arch}, Node ${process.versions.node.split(".")[0]}`;
const HEADLINE = "OpenQodex had a problem. Nothing has been sent.";
const LATER = "To create the issue, run: openqodex report --send-last\nTo ignore it, do nothing\n";

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `oq-feedback-${prefix}-`));
}

// A folder for PATH with git and a recorder for the browser openers.
function harness(): { path: string; record: string } {
  const bin = temp("bin");
  const record = join(temp("record"), "url.txt");
  const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(git, join(bin, "git"));
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > '${record}'\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { path: bin, record };
}

type Result = { code: number | null; stdout: string; stderr: string };

function cli(args: string[], cwd: string, h: { path: string }, env: Record<string, string> = {}, input = ""): Result {
  const base: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: temp("home"), NO_COLOR: "1", PATH: h.path, ...env };
  for (const key of ["FORCE_COLOR", "GH_TOKEN", "GITHUB_TOKEN"]) delete base[key];
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: base, input, timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd });
}

// A repo named acme-payments-<random letters> with one commit and `files` written
// on top of it, uncommitted.
function repo(files: (dir: string) => void): string {
  const dir = join(temp("parent"), `acme-payments-${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("")}`);
  mkdirSync(dir);
  git(dir, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "notes.txt"), "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  files(dir);
  return dir;
}

function offers(stderr: string): number {
  return stderr.split(HEADLINE).length - 1;
}

// The title and body as the offer printed them.
function shown(stderr: string): { title: string; body: string } {
  const m = /Issue title: (.*)\nIssue body:\n([\s\S]*?)\n1 create a GitHub issue\n2 ignore\n/.exec(stderr);
  if (m === null) throw new Error(`no offer in:\n${stderr}`);
  return { title: m[1] as string, body: m[2] as string };
}

describe("feedback offer", () => {
  it("an internal error prints the exact issue with the two choices, sends nothing, keeps paths out and exits 2", () => {
    const h = harness();
    const dir = repo((d) => writeFileSync(join(d, "notes.txt"), "a\nb\n"));
    const missing = join(dir, "no-such-folder", "out.txt");
    const r = cli(["scan", "--no-install", "--only", "sqllint", "--output", missing], dir, h);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("openqodex failed: ENOENT");
    const text = [
      HEADLINE,
      `Issue title: OpenQodex ${VERSION}: internal-error`,
      "Issue body:",
      "Command: scan --no-install --only sqllint --output <path>",
      "Component: cli",
      "Diagnostic: ENOENT: no such file or directory, open '<path>'",
      "Scanners: sqllint no_matching_files",
      ENVIRONMENT,
      "1 create a GitHub issue",
      "2 ignore",
      "",
    ].join("\n");
    expect(r.stderr).toContain(text + LATER);
    expect(offers(r.stderr)).toBe(1);
    expect(existsSync(h.record)).toBe(false);
    const kept = JSON.parse(readFileSync(join(dir, ".openqodex", "last-report.json"), "utf8")) as { body: string };
    expect(kept.body).not.toContain(dir);
    expect(kept.body).not.toContain(basename(dir));
  });

  it("a scanner that failed prints the offer once without the file name, and a scanner not installed prints none", () => {
    const h = harness();
    // A .sql entry that is not a regular file: the in-process SQL scanner
    // refuses to read it and ends failed.
    const failing = repo((d) => symlinkSync("/dev/null", join(d, "ledger-migration.sql")));
    const r = cli(["scan", "--no-install", "--only", "sqllint"], failing, h);
    expect(r.code).toBe(0);
    expect(offers(r.stderr)).toBe(1);
    const issue = shown(r.stderr);
    expect(issue.title).toBe(`OpenQodex ${VERSION}: scanner-failed`);
    expect(issue.body).toContain("Component: scanner:sqllint");
    expect(issue.body).toContain("Scanners: sqllint failed");
    expect(issue.body).not.toContain("ledger-migration");
    expect(issue.body).not.toContain(basename(failing));
    expect(r.stderr).toContain(LATER);

    const missing = repo((d) => writeFileSync(join(d, "app.py"), "x = 1\n"));
    const quiet = cli(["scan", "--no-install"], missing, h);
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toMatch(/not installed/);
    expect(offers(quiet.stderr)).toBe(0);
  });

  it("report strips paths, the user name, the repo name and a key-shaped token from a hostile message", () => {
    const h = harness();
    const dir = repo(() => {});
    const name = basename(dir);
    const words =
      `scan crashed in /Users/zorbuser/${name}/src/pay.ts and C:\\Users\\zorbuser\\cache ` +
      `after ~/.config/x; zorbuser saw ${name} print ghp_AbCdEf0123456789XyZaBcDeF012345`;
    const r = cli(["report", words], dir, h, { USER: "zorbuser" });
    expect(r.code).toBe(0);
    const issue = shown(r.stderr);
    expect(issue.title).toBe(`OpenQodex ${VERSION}: developer-report`);
    expect(issue.body).toContain("Command: report\nComponent: report\n");
    expect(issue.body).toContain(
      "Diagnostic: scan crashed in <path> and <path> after <path>; <name> saw <name> print <secret>",
    );
    for (const leak of ["zorbuser", name, "/Users", "\\", "~", "ghp_", "pay.ts"]) expect(issue.body).not.toContain(leak);
    expect(existsSync(h.record)).toBe(false);
  });

  it("report --send-last opens the new issue page with exactly the shown title and body", () => {
    const h = harness();
    const dir = repo(() => {});
    const r = cli(["report", "the review hung after the brief"], dir, h);
    const issue = shown(r.stderr);
    expect(existsSync(h.record)).toBe(false);

    const sent = cli(["report", "--send-last"], dir, h);
    expect(sent.code).toBe(0);
    const url = new URL(readFileSync(h.record, "utf8"));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/openqodex/openqodex/issues/new");
    expect(url.searchParams.get("title")).toBe(issue.title);
    expect(url.searchParams.get("body")).toBe(issue.body);
    expect(sent.stdout).toContain(url.href.split("?")[0]);
  });

  it("hook check prints no offer and exits 0 when its input breaks", () => {
    const h = harness();
    const dir = repo(() => {});
    const r = cli(["hook", "check"], dir, h, {}, "{not json");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(offers(r.stderr)).toBe(0);
    expect(r.stderr).not.toContain("send-last");
  });
});
