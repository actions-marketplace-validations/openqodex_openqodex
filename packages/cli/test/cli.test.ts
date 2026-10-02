// The CLI commands, run as real subprocesses of the built dist/bin.js in real
// temp git repos. Build first (`pnpm build`). No scanner is installed:
// OPENQODEX_HOME points at an empty temp folder and --no-install is passed,
// so every scanner the change needs is reported as not installed and the run
// has zero candidates. Which findings the scanners report belongs to the
// end-to-end tests. Temp folders are left to the system's temp cleanup.
//
// Ways these commands could fail, written before the code:
// 1. An unknown flag, a flag missing its value or a bad --format value runs
//    anyway, or exits with something other than 2.
// 2. Outside a git repository a command crashes with a stack, or exits 0.
// 3. An empty change scans, writes a report or exits non-zero.
// 4. review --agent changes `git status --porcelain` (writes outside the
//    self-ignored .openqodex/), or does not write the brief, manifest, scan,
//    candidate list and latest.json.
// 5. review --finalize accepts a submission for a different change id, or
//    invalid JSON, or a submission that breaks the schema, or a run whose
//    files changed since the brief, or a config that changed since the
//    brief, and writes a report anyway.
// 6. A finding on a file outside the change counts toward the verdict
//    instead of landing in "Outside the changed lines".
// 7. block_on_severity is ignored, so a critical finding exits 0, or the
//    verdict blocks without it.
// 8. A finalize with no brief, or with no findings file, crashes or exits
//    other than 2 without saying what to run.
// 9. guide finds its files from the current directory, so it fails from an
//    installed package or another folder; an unknown topic exits 0.
// 10. demo writes into a non-empty folder, commits the planted change,
//     ships a fixed secret, or needs the user's git identity.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(cliRoot, "dist", "bin.js");
let home = "";

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `oq-cli-${prefix}-`));
  return dir;
}

type Result = { code: number | null; stdout: string; stderr: string };

// The test runner sets FORCE_COLOR; the CLI is run as a user would run it.
function cliEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENQODEX_HOME: home, NO_COLOR: "1", ...extra };
  delete env.FORCE_COLOR;
  return env;
}

function cli(args: string[], cwd: string, env: Record<string, string> = {}): Result {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: "utf8",
    env: cliEnv(env),
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
}

function status(cwd: string): string {
  return git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
}

// A repo with one commit and an uncommitted change to app.py (lines 2 and 3)
// plus one untracked file.
function repoWithChange(config?: string): string {
  const dir = temp("repo");
  git(dir, ["init", "--quiet", "-b", "main"]);
  writeFileSync(join(dir, "app.py"), "def a():\n    return 1\n");
  writeFileSync(join(dir, "other.py"), "x = 1\n");
  if (config !== undefined) writeFileSync(join(dir, ".openqodex.yaml"), config);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "base"]);
  writeFileSync(join(dir, "app.py"), "def a():\n    return 2\n\ndef b():\n    return 3\n");
  writeFileSync(join(dir, "new.py"), "y = 2\n");
  return dir;
}

function latestDir(repo: string): string {
  const latest = JSON.parse(readFileSync(join(repo, ".openqodex", "latest.json"), "utf8")) as { dir: string };
  return join(repo, latest.dir);
}

function brief(repo: string): { dir: string; changeId: string } {
  const r = cli(["review", "--agent", "--no-install"], repo);
  expect(r.stderr).not.toContain("openqodex failed");
  expect(r.code).toBe(0);
  const dir = latestDir(repo);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { change_id: string };
  return { dir, changeId: manifest.change_id };
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "major",
    category: "bug",
    confidence: 0.9,
    file_path: "app.py",
    line_number: 2,
    title: "Returns the wrong value",
    description: "a() now returns 2.",
    suggested_change: null,
    source: null,
    ...over,
  };
}

function submit(dir: string, changeId: string, findings: unknown[], extra: Record<string, unknown> = {}): void {
  const body = { version: 1, change_id: changeId, summary: "Checked.", findings, ...extra };
  writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(body));
}

beforeAll(() => {
  if (!existsSync(BIN)) throw new Error(`build first: ${BIN} is missing`);
  home = temp("home");
});

describe("frame", () => {
  it("a bad flag or value runs anyway instead of exiting 2 with one line", () => {
    const repo = repoWithChange();
    for (const args of [["scan", "--bogus"], ["scan", "--base"], ["review", "--format", "xml"], ["doctor", "extra"]]) {
      const r = cli(args, repo);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stdout).toBe("");
    }
  });

  it("outside a git repository the command exits 0 or crashes", () => {
    const r = cli(["scan", "--no-install"], temp("plain"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not a git repository");
  });

  it("an empty change scans, writes state or exits non-zero", () => {
    const repo = repoWithChange();
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "--quiet", "-m", "all"]);
    for (const cmd of [["scan"], ["review", "--agent"], ["review"]]) {
      const r = cli([...cmd, "--no-install", "--uncommitted"], repo);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("Nothing to review: no changes against HEAD");
    }
    expect(existsSync(join(repo, ".openqodex"))).toBe(false);
  });
});

describe("review --agent and --finalize", () => {
  it("review --agent misses a run file or changes git status", () => {
    const repo = repoWithChange();
    const before = status(repo);
    const r = cli(["review", "--agent", "--no-install"], repo);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("review --finalize");
    const dir = latestDir(repo);
    for (const f of ["brief.md", "manifest.json", "scan.json", "candidates.json", "run.json"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(r.stdout).toContain(join(dir, "agent-findings.json"));
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as {
      candidates: unknown[];
      scanners: { status: string }[];
    };
    expect(scan.candidates).toEqual([]);
    // Installs are off and the tool folder is empty: every scanner the
    // change needs is reported as not installed, and none of them ran.
    expect(scan.scanners.some((s) => s.status === "not_installed")).toBe(true);
    expect(scan.scanners.filter((s) => s.status === "ran")).toEqual([]);
    expect(status(repo)).toBe(before);
  });

  it("a valid submission is refused, or an off-change finding counts, or git status changes", () => {
    const repo = repoWithChange();
    const before = status(repo);
    const { dir, changeId } = brief(repo);
    submit(dir, changeId, [finding(), finding({ file_path: "other.py", line_number: 1, title: "Elsewhere" })]);
    const r = cli(["review", "--finalize"], repo);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    for (const f of ["report.md", "report.json", "report.sarif"]) expect(existsSync(join(dir, f)), f).toBe(true);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as {
      verdict: string;
      findings: { title: string }[];
      outside_change: { title: string }[];
    };
    expect(report.verdict).toBe("passed");
    expect(report.findings.map((f) => f.title)).toEqual(["Returns the wrong value"]);
    expect(report.outside_change.map((f) => f.title)).toEqual(["Elsewhere"]);
    expect(r.stdout).toContain("Outside the changed lines");
    const latest = JSON.parse(readFileSync(join(repo, ".openqodex", "latest.json"), "utf8")) as {
      finalized: boolean;
      verdict: string;
    };
    expect(latest).toMatchObject({ finalized: true, verdict: "passed" });
    expect(status(repo)).toBe(before);
  });

  it("a findings file outside the report folder cannot find its run", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    const elsewhere = join(temp("findings"), "findings.json");
    writeFileSync(elsewhere, JSON.stringify({ version: 1, change_id: changeId, summary: "ok", findings: [] }));
    const r = cli(["review", "--finalize", elsewhere], repo);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "report.json"))).toBe(true);
  });

  it("a wrong change id, invalid JSON or a schema error still writes a report", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);

    submit(dir, "0123456789ab", [finding()]);
    let r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the change moved");

    writeFileSync(join(dir, "agent-findings.json"), "{ not json");
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not valid JSON");

    submit(dir, changeId, [finding({ severity: "huge" })]);
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("findings[0].severity");

    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("a file edited after the brief still finalizes", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    writeFileSync(join(repo, "app.py"), "def a():\n    return 4\n");
    submit(dir, changeId, [finding()]);
    const r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the change moved");
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("a config changed after the brief still finalizes", () => {
    const repo = repoWithChange();
    const { dir, changeId } = brief(repo);
    writeFileSync(join(repo, ".openqodex.yaml"), "version: 1\nreview:\n  block_on_severity: major\n");
    submit(dir, changeId, [finding()]);
    const r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("config changed");
    expect(existsSync(join(dir, "report.json"))).toBe(false);
  });

  it("block_on_severity is ignored or blocks below the threshold", () => {
    const repo = repoWithChange("version: 1\nreview:\n  block_on_severity: critical\n");
    const { dir, changeId } = brief(repo);
    submit(dir, changeId, [finding({ severity: "major" })]);
    expect(cli(["review", "--finalize"], repo).code).toBe(0);
    submit(dir, changeId, [finding({ severity: "critical" })]);
    const r = cli(["review", "--finalize", "--format", "json"], repo);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stdout) as { verdict: string }).verdict).toBe("blocked");
  });

  it("finalize with no brief or no findings file crashes instead of naming the step", () => {
    const repo = repoWithChange();
    let r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("review --agent");
    brief(repo);
    r = cli(["review", "--finalize"], repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("agent-findings.json");
  });
});

describe("scan", () => {
  it("scan misses a report file or changes git status", () => {
    const repo = repoWithChange();
    const before = status(repo);
    const r = cli(["scan", "--no-install", "--format", "json"], repo);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { kind: string }).kind).toBe("scan");
    const dir = latestDir(repo);
    for (const f of ["scan.json", "change.diff", "report.md", "report.json", "report.sarif"]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
    }
    expect(status(repo)).toBe(before);
  });
});

describe("guide", () => {
  it("an unknown topic exits 0", () => {
    const bad = cli(["guide", "no-such-topic"], tmpdir());
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Topics:");
  });

  it("guide reads assets from the current folder, so an installed package finds nothing", () => {
    const packDir = temp("pack");
    execFileSync("npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: cliRoot, encoding: "utf8" });
    const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
    expect(tgz).toBeDefined();
    const install = temp("install");
    writeFileSync(join(install, "package.json"), "{}");
    execFileSync("npm", ["install", "--offline", "--no-audit", "--no-fund", join(packDir, tgz as string)], {
      cwd: install,
      encoding: "utf8",
    });
    const bin = join(install, "node_modules", "openqodex", "dist", "bin.js");
    const elsewhere = temp("elsewhere");
    const r = spawnSync(process.execPath, [bin, "guide"], { cwd: elsewhere, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("name: openqodex");
    const docs = join(install, "node_modules", "openqodex", "docs");
    if (existsSync(docs)) {
      const topic = readdirSync(docs).find((f) => f.endsWith(".md"))?.slice(0, -3);
      if (topic !== undefined) {
        const t = spawnSync(process.execPath, [bin, "guide", topic], { cwd: elsewhere, encoding: "utf8" });
        expect(t.status).toBe(0);
        expect(t.stdout).toBe(readFileSync(join(docs, `${topic}.md`), "utf8"));
      }
    }
  });
});

describe("demo", () => {
  it("demo commits the plant, needs a git identity or reuses a fixed key", () => {
    const keys: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = join(temp("demo"), "repo");
      // No git identity anywhere: the demo must not need one.
      const r = cli(["demo", dir, "--no-install"], tmpdir(), { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      expect(r.stderr).not.toContain("openqodex failed");
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("review my change with openqodex");
      const changed = status(dir);
      for (const f of ["app/config.py", "app/search.py", "Dockerfile", "scripts/deploy.sh"]) expect(changed).toContain(f);
      const config = readFileSync(join(dir, "app", "config.py"), "utf8");
      const key = /sk_live_[A-Za-z0-9]{24}/.exec(config)?.[0];
      expect(key).toBeDefined();
      expect(config).not.toContain("{{GENERATED_SECRET}}");
      keys.push(key as string);
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("demo writes into a folder that is not empty", () => {
    const dir = temp("full");
    mkdirSync(join(dir, "x"));
    const r = cli(["demo", dir, "--no-install"], tmpdir());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not empty");
  });
});
