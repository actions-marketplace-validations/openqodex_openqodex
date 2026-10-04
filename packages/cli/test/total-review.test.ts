// The total review's run, on real temp repositories with the real change
// source, checkout, scanner runner (the in-process SQL checks) and
// renderers. The reviewer model is the one stand-in: a driver object that
// implements the driver interface and answers with recorded submissions.
//
// Ways it could fail, written before the code:
//  1. A candidate with no disposition still yields a complete report or exit 0.
//  2. The correction rounds are not bounded.
//  3. The trace shows a read outside the snapshot and the run completes.
//  4. The snapshot is left on disk after success, after a failure or after a timeout.
//  5. A file edited in the developer's folder during the run changes what was reviewed.
//  6. A nested review starts.
//  7. With no driver available it prints findings or exits 0.
//  8. Progress lines land on stdout and break --format json.
//  9. A complete review that is blocked does not exit 1.
// 10. A secret the scanners found is shown to the reviewer in the snapshot.
// 11. A timeout leaves a child process running.
// 12. The numbered errors are not sent back to the same session.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { DEPTH_ENV, killGroup, spawnGroup } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { redactSnapshot, runReview } from "../src/review-run.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

const SQL = "CREATE OR REPLACE FUNCTION public.admin_get_hygiene()\nRETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT 1 $$;\n";

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

// A repo with one commit and an uncommitted SQL file the in-process check flags as c1.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-total-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  mkdirSync(join(dir, "db"));
  writeFileSync(join(dir, "db/x.sql"), SQL);
  return dir;
}

type Answer = (text: string, snapshotDir: string) => Partial<Turn> | Promise<Partial<Turn>>;
type Fake = ReviewerDriver & { sent: string[]; snapshots: string[]; closed: number };

// The model provider stand-in: each send answers with the next recorded turn.
function fake(answers: Answer[], available = true): Fake {
  const driver: Fake = {
    name: "claude",
    sent: [],
    snapshots: [],
    closed: 0,
    async detect() {
      return available ? { ok: true as const, version: "9.9.9", bin: "/fake/claude" } : { ok: false as const, missing: "claude is not installed", fix: "install Claude Code" };
    },
    start({ snapshotDir }): ReviewerSession {
      driver.snapshots.push(snapshotDir);
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          driver.sent.push(text);
          const next = answers[driver.sent.length - 1] ?? answers[answers.length - 1]!;
          const t = await next(text, snapshotDir);
          return { finalText: "", trace: [], usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, sessionId: "fake", failure: null, ...t };
        },
        async close() {
          driver.closed++;
        },
      };
    },
  };
  return driver;
}

const changeIdOf = (brief: string) => /`change_id`: `([0-9a-f]{12})`/.exec(brief)?.[1] ?? "missing";

function submission(brief: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    change_id: changeIdOf(brief),
    summary: "Adds an admin SQL function.",
    findings: [
      {
        severity: "major",
        category: "security",
        confidence: 0.9,
        file_path: "db/x.sql",
        line_number: 1,
        title: "Admin function callable by anyone",
        problem: "The new admin function keeps the default execute grant for every role.",
        consequence: "Any signed in user can call an admin function.",
        fix: "Revoke execute from public and grant it to the service role only.",
        source: "sqllint:function-default-public-execute",
        candidate: "c1",
      },
    ],
    dropped: [],
    ...over,
  });
}

const good: Answer = (text) => ({ finalText: submission(text) });
const noDisposition: Answer = (text) => ({ finalText: submission(text, { findings: [] }) });

let out: string;
let err: string;
let home: string;
beforeEach(() => {
  out = "";
  err = "";
  home = mkdtempSync(join(tmpdir(), "oq-total-home-"));
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(dir: string, driver: ReviewerDriver, extra: string[] = [], timeoutMs = 60_000): Promise<number> {
  const { global } = parseFlags(["--cwd", dir, "--no-color", "--format", "json", ...extra], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer: "auto", timeoutMs, drivers: [driver] });
}

const checkouts = () => (existsSync(join(home, "checkouts")) ? readdirSync(join(home, "checkouts")) : []);

describe("the total review run", () => {
  it("1, 8. a complete review exits 0 under warn only, prints one JSON document and leaves nothing on stdout but the report", async () => {
    const driver = fake([good]);
    expect(await review(repo(), driver)).toBe(0);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("complete");
    expect(report.completion?.reviewer).toMatchObject({ driver: "claude", version: "9.9.9", pid: 4242 });
    expect(err).toContain("Reviewer");
  });

  it("9. a complete review blocked at block_on_severity exits 1", async () => {
    const dir = repo();
    mkdirSync(join(dir, ".openqodex"), { recursive: true });
    writeFileSync(join(dir, ".openqodex/config.yaml"), "review:\n  block_on_severity: major\n");
    expect(await review(dir, fake([good]))).toBe(1);
    expect((JSON.parse(out) as Report).verdict).toBe("blocked");
  });

  it("1, 2, 12. a candidate left with no disposition gets two correction rounds in the same session, then exits 2 incomplete", async () => {
    const driver = fake([noDisposition]);
    expect(await review(repo(), driver)).toBe(2);
    expect(driver.sent).toHaveLength(3);
    expect(driver.snapshots).toHaveLength(1);
    expect(driver.sent[1]).toMatch(/^1\. .*c1/m);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("incomplete");
    expect(report.findings).toEqual([]);
  });

  it("a correction round that fixes the answer completes", async () => {
    const driver = fake([noDisposition, good]);
    expect(await review(repo(), driver)).toBe(0);
    expect(driver.sent).toHaveLength(2);
  });

  it("3. a successful read outside the snapshot makes the run incomplete", async () => {
    const outside: Answer = (text) => ({ finalText: submission(text), trace: [{ tool: "Read", path: "/etc/hosts", inside: false, range: [1, 3], ok: true }] });
    expect(await review(repo(), fake([outside]))).toBe(2);
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toContain("/etc/hosts");
  });

  it("4. removes the snapshot after success, after a driver failure and after a timeout", async () => {
    await review(repo(), fake([good]));
    expect(checkouts()).toEqual([]);
    const boom: Answer = () => {
      throw new Error("the reviewer crashed");
    };
    expect(await review(repo(), fake([boom]))).toBe(2);
    expect(checkouts()).toEqual([]);
    const slow: Answer = () => new Promise(() => {});
    const driver = fake([slow]);
    expect(await review(repo(), driver, [], 1_000)).toBe(2);
    expect(driver.closed).toBe(1);
    expect(checkouts()).toEqual([]);
    expect(err).toMatch(/timed out/);
  });

  it("5. an edit in the developer's folder during the review does not change what was reviewed", async () => {
    const dir = repo();
    let seen = "";
    const edit: Answer = (text, snapshotDir) => {
      writeFileSync(join(dir, "db/x.sql"), "-- replaced while the review ran\n");
      seen = readFileSync(join(snapshotDir, "db/x.sql"), "utf8");
      return { finalText: submission(text) };
    };
    expect(await review(dir, fake([edit]))).toBe(0);
    expect(seen).toBe(SQL);
    expect((JSON.parse(out) as Report).completion?.status).toBe("complete");
  });

  it("6. refuses to start inside a reviewer", async () => {
    vi.stubEnv(DEPTH_ENV, "1");
    const driver = fake([good]);
    await expect(review(repo(), driver)).rejects.toThrow(/inside an openqodex reviewer/);
    expect(driver.sent).toEqual([]);
  });

  it("7. with no driver available exits 2, says what is missing and saves the unchecked candidates without printing them", async () => {
    const dir = repo();
    expect(await review(dir, fake([good], false))).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("Full review unavailable");
    expect(err).toContain("claude is not installed");
    const path = /Unchecked scanner candidates, not a review: (\S+)/.exec(err)?.[1];
    expect(path).toBeDefined();
    const saved = JSON.parse(readFileSync(path!, "utf8")) as { label: string; candidates: unknown[] };
    expect(saved.label).toMatch(/unchecked/);
    expect(saved.candidates).toHaveLength(1);
    expect(err).not.toContain("function-default-public-execute");
    expect(checkouts()).toEqual([]);
  });
});

describe("the snapshot", () => {
  it("10. redacts every copy of a secret the scanners found and leaves the developer's files alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-redact-"));
    const secret = ["sk", "live", Math.random().toString(36).slice(2).padEnd(24, "x")].join("_");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app/config.py"), `KEY = "${secret}"\n`);
    writeFileSync(join(dir, "app/other.py"), `# copied: ${secret}\nx = 1\n`);
    writeFileSync(join(dir, ".git"), "gitdir: /somewhere\n");
    redactSnapshot(dir, [secret]);
    expect(readFileSync(join(dir, "app/config.py"), "utf8")).not.toContain(secret);
    expect(readFileSync(join(dir, "app/other.py"), "utf8")).toBe("# copied: [redacted]\nx = 1\n");
  });
});

describe("the reviewer process", () => {
  it("11. killing the group on timeout leaves no child or grandchild running", async () => {
    const script = "const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);";
    const child = spawnGroup(process.execPath, ["-e", script], { cwd: tmpdir(), env: process.env });
    const grandchild = await new Promise<number>((done) => child.stdout!.once("data", (b: Buffer) => done(Number(String(b).trim()))));
    killGroup(child);
    await new Promise((done) => child.once("exit", done));
    await new Promise((done) => setTimeout(done, 200));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(child.pid!)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });
});
