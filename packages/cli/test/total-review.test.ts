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
// 13. A tool call escapes the trace check: a relative path with ../, an
//     absolute path, a Grep path or a Glob pattern rooted outside, an unknown
//     tool, or an input that cannot be read still lets the run complete.
// 14. The reviewer's environment carries a token of the developer's.
// 15. A run file that may quote the code is readable by other users.
// 16. A binary file with a secret in it reaches the reviewer unredacted.
// 17. Stderr echoes the reviewer's raw answer.
// 18. A Glob alternative list, a `..` inside a pattern, or a wildcard on the
//     snapshot folder's own name reaches outside and the run completes; or a
//     Grep search expression is taken for a path and fails a clean run.
// 20. A `claude` the repository owns is run by detection: one in a PATH
//     folder reached through a link into the repo, one in a folder whose
//     name starts with two dots (`<repo>/..tools`), or one that is a link
//     into the repo from a folder outside it.
// 21. A secret the scanners found that also sits in a file name reaches the
//     reviewer through a listing, or a secret in a tool call's input lands
//     raw in trace.json or the completion record.
// 22. Coverage depends on the model choosing to open a file: changed ranges
//     the brief could not carry, deletions included, must reach the reviewer
//     in the correction rounds, bounded per round, and count as given.
// 23. A correction round is skipped while ranges are still unread, or a
//     third one runs.
// 24. An incomplete review drops the findings that passed every check, or
//     writes a record the push hooks could count as a review.
// 25. A correction message carries a secret: text from git objects or the
//     developer's folder instead of the redacted snapshot, a secret a broken
//     redaction left in place, a file the snapshot dropped or a binary file,
//     or megabytes in one long line.
// 26. With no reviewer available (Codex only, Cursor only, Claude Code
//     logged out), the developer is left with no AI review: the message does
//     not name the fallback through the agent they are in; or the fallback
//     text shows when a reviewer is available.
// 27. A fallback review (review --agent, then --finalize) cannot be finished
//     from the brief alone, now that the skill no longer describes it; or it
//     is not labelled as a review by the same agent in some output format, or
//     writes no legacy record for the push hooks.
// 19. Redacting a multi-line secret (a private key) joins its lines, so every
//     line below it moves while scanner locations and citations do not.
// 28. With a reviewer whose trace is not complete (Codex), a read it claims
//     counts as coverage, or a command it ran outside the snapshot fails the
//     review, or the report prints "Files not read" for reads it never measured.
// 29. With such a reviewer, ranges the correction rounds could not carry are
//     reported as read, or the run completes.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { DEPTH_ENV, killGroup, spawnGroup } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { DELIVER_LINES, deliverRanges, redactSnapshot, runReview } from "../src/review-run.js";
import { claudeDriver, reviewerEnv } from "../src/reviewers/claude.js";
import type { ToolCall } from "../src/reviewers/trace.js";
import { readHomeReceipt } from "../src/receipts.js";
import { cli, sandbox } from "./init-helpers.js";

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
    traced: true,
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
          // Every answer is built from the brief, the first text the session got.
          const t = await next(driver.sent[0] ?? text, snapshotDir);
          return { finalText: "", calls: [], usage: { turns: 1, input_tokens: 10, output_tokens: 5, cost_usd: 0.01 }, sessionId: "fake", failure: null, ...t };
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
    const code = await review(repo(), driver);
    expect((JSON.parse(out) as Report).completion?.missing).toEqual([]);
    expect(code).toBe(0);
    expect(driver.sent).toHaveLength(2);
  });

  it("3. a successful read outside the snapshot makes the run incomplete", async () => {
    const outside: Answer = (text) => ({ finalText: submission(text), calls: [{ tool: "Read", input: { file_path: "/etc/hosts" }, ok: true, read: { path: "/etc/hosts", start: 1, lines: 3 } }] });
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

describe("13. the trace check fails closed", () => {
  const cases: [string, ToolCall][] = [
    ["a relative path that climbs out with ../", { tool: "Read", input: { file_path: "../../../etc/hosts" }, ok: true, read: null }],
    ["an absolute path outside", { tool: "Read", input: { file_path: "/etc/hosts" }, ok: false, read: null }],
    ["a Grep with its path outside", { tool: "Grep", input: { pattern: "key", path: "/Users" }, ok: true, read: null }],
    ["a Glob pattern rooted outside", { tool: "Glob", input: { pattern: "/etc/**/*.conf" }, ok: true, read: null }],
    ["a Glob pattern that climbs out", { tool: "Glob", input: { pattern: "../**/*" }, ok: true, read: null }],
    ["a home path", { tool: "Read", input: { file_path: "~/.ssh/config" }, ok: true, read: null }],
    ["an environment-style path", { tool: "Read", input: { file_path: "$HOME/.ssh/config" }, ok: true, read: null }],
    ["a URL-encoded path", { tool: "Read", input: { file_path: "%2e%2e/%2e%2e/etc/hosts" }, ok: true, read: null }],
    ["an unknown tool", { tool: "Bash", input: { command: "ls" }, ok: true, read: null }],
    ["an input that cannot be read", { tool: "Read", input: "not an object", ok: true, read: null }],
    ["a path that is not text", { tool: "Grep", input: { pattern: "x", path: 7 }, ok: true, read: null }],
    ["a Glob alternative list that climbs out", { tool: "Glob", input: { pattern: "{../outside/*.txt,*.ts}" }, ok: true, read: null }],
    ["a Glob pattern with .. in the middle", { tool: "Glob", input: { pattern: "src/**/../../../*" }, ok: true, read: null }],
    ["a Grep file glob that climbs out", { tool: "Grep", input: { pattern: "key", glob: "../*.env" }, ok: true, read: null }],
  ];
  for (const [name, call] of cases) {
    it(`${name} makes the run incomplete`, async () => {
      const answer: Answer = (text) => ({ finalText: submission(text), calls: [call] });
      expect(await review(repo(), fake([answer]))).toBe(2);
      expect((JSON.parse(out) as Report).completion?.status).toBe("incomplete");
    });
  }
  it("reads inside the snapshot, relative or absolute, keep the run complete", async () => {
    const answer: Answer = (text, snapshotDir) => ({
      finalText: submission(text),
      calls: [
        { tool: "Read", input: { file_path: join(snapshotDir, "db/x.sql") }, ok: true, read: { path: join(snapshotDir, "db/x.sql"), start: 1, lines: 2 } },
        { tool: "Grep", input: { pattern: "admin", path: "db" }, ok: true, read: null },
        { tool: "Glob", input: { pattern: "**/*.sql" }, ok: true, read: null },
      ],
    });
    expect(await review(repo(), fake([answer]))).toBe(0);
    expect((JSON.parse(out) as Report).completion?.coverage.files_read).toEqual(["db/x.sql"]);
  });
  it("an absolute Glob pattern whose wildcard reaches a sibling of the snapshot makes the run incomplete", async () => {
    const answer: Answer = (text, snapshotDir) => ({ finalText: submission(text), calls: [{ tool: "Glob", input: { pattern: `${snapshotDir}*/**/*` }, ok: true, read: null }] });
    expect(await review(repo(), fake([answer]))).toBe(2);
  });
  it("a Glob extension list and an absolute pattern rooted in the snapshot keep the run complete", async () => {
    const answer: Answer = (text, snapshotDir) => ({ finalText: submission(text), calls: [{ tool: "Glob", input: { pattern: "**/*.{sql,py}" }, ok: true, read: null }, { tool: "Glob", input: { pattern: `${snapshotDir}/**/*.{sql,py}` }, ok: true, read: null }] });
    expect(await review(repo(), fake([answer]))).toBe(0);
  });
  it("a Glob alternative list rooted outside is named by its pattern in the record", async () => {
    const answer: Answer = (text) => ({ finalText: submission(text), calls: [{ tool: "Glob", input: { pattern: "{/etc/*,*.sql}" }, ok: true, read: null }] });
    expect(await review(repo(), fake([answer]))).toBe(2);
    expect((JSON.parse(out) as Report).completion?.outside_reads).toEqual(["{/etc/*,*.sql}"]);
  });
  it("a Grep search expression that looks like a path is not a path and keeps the run complete", async () => {
    const answer: Answer = (text) => ({ finalText: submission(text), calls: [{ tool: "Grep", input: { pattern: "/api/../v1", path: "db" }, ok: true, read: null }] });
    expect(await review(repo(), fake([answer]))).toBe(0);
  });
});

describe("what leaves the process", () => {
  it("14. the reviewer's environment holds no token of the developer's", () => {
    const env = reviewerEnv({ PATH: "/usr/bin", HOME: "/h", USER: "u", CLAUDE_CONFIG_DIR: "/c", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g", NPM_TOKEN: "n", AWS_SECRET_ACCESS_KEY: "a", OPENAI_API_KEY: "o", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s" });
    expect(Object.keys(env).sort()).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "HOME", DEPTH_ENV, "PATH", "USER"].sort());
    expect(reviewerEnv({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "r", GITHUB_TOKEN: "g" })).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "r" });
  });
  it("15. every file of the run folder is readable by its owner only", async () => {
    const dir = repo();
    expect(await review(dir, fake([good]))).toBe(0);
    const run = join(dir, ".openqodex/reviews", readdirSync(join(dir, ".openqodex/reviews"))[0]!);
    const files = readdirSync(run);
    expect(files).toEqual(expect.arrayContaining(["brief.md", "scan.json", "submission.json", "trace.json", "report.md"]));
    for (const name of files) expect((statSync(join(run, name)).mode & 0o777).toString(8), name).toBe("600");
  });
  it("17. stderr never echoes the reviewer's raw answer", async () => {
    const canary = "CANARY-RAW-ANSWER-4417";
    expect(await review(repo(), fake([() => ({ finalText: `not json ${canary}` })]))).toBe(2);
    expect(err).not.toContain(canary);
  });
});

// The installed gitleaks of the end-to-end home or the developer's home, for
// the cases that need a secret found by the real scanner; null when neither has it.
function installedGitleaks(): string | null {
  for (const h of [process.env.OPENQODEX_E2E_HOME ?? join(tmpdir(), "openqodex-e2e-home"), join(homedir(), ".openqodex")]) {
    if (existsSync(join(h, "tools/gitleaks"))) return join(h, "tools/gitleaks");
  }
  return null;
}

describe("21. secrets outside file contents", () => {
  const gitleaks = installedGitleaks();
  const secret = () => `sk_live_${Array.from({ length: 24 }, () => "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 57)]).join("")}`;
  const withSecret = (key: string, inName: boolean): string => {
    const dir = repo();
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app/config.py"), `STRIPE_KEY = "${key}"\n`);
    if (inName) writeFileSync(join(dir, `app/${key}.txt`), "notes\n");
    return dir;
  };
  const reviewWithGitleaks = (dir: string, driver: ReviewerDriver) => {
    cpSync(gitleaks!, join(home, "tools/gitleaks"), { recursive: true });
    const { global } = parseFlags(["--cwd", dir, "--no-color", "--format", "json", "--no-install"], {});
    return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint,gitleaks", reviewer: "auto", timeoutMs: 60_000, drivers: [driver] });
  };
  const runFiles = (dir: string) => {
    const run = join(dir, ".openqodex/reviews", readdirSync(join(dir, ".openqodex/reviews"))[0]!);
    return readdirSync(run).map((n) => readFileSync(join(run, n), "utf8")).join("\n");
  };

  it("a secret in a file name stops the review before the reviewer starts, and is printed nowhere", async () => {
    if (gitleaks === null) return void process.stdout.write("filename secret: skipped, gitleaks is not installed\n");
    const key = secret();
    const dir = withSecret(key, true);
    const driver = fake([good]);
    expect(await reviewWithGitleaks(dir, driver)).toBe(2);
    expect(driver.snapshots).toEqual([]);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("incomplete");
    expect(report.completion?.missing.join("\n")).toMatch(/file name/);
    expect(out + err + runFiles(dir)).not.toContain(key);
  });

  it("a secret in a tool call's input is redacted in trace.json and the completion record", async () => {
    if (gitleaks === null) return void process.stdout.write("trace secret: skipped, gitleaks is not installed\n");
    const key = secret();
    const dir = withSecret(key, false);
    const leak: Answer = () => ({ finalText: "not json", calls: [{ tool: "Read", input: { file_path: `/outside/${key}` }, ok: false, read: null }] });
    expect(await reviewWithGitleaks(dir, fake([leak]))).toBe(2);
    expect(out + err + runFiles(dir)).not.toContain(key);
  });
});

describe("22, 23, 24. ranges the brief could not carry", () => {
  // A committed file, then `lines` new lines of 80 characters: too large for
  // the brief's diff, so the reviewer is not given it there.
  function bigChange(lines: number, deleteAt?: number): string {
    const dir = repo();
    const base = Array.from({ length: 20 }, (_, i) => `kept line ${i + 1}`);
    writeFileSync(join(dir, "big.txt"), `${base.join("\n")}\n`);
    git(dir, "add", "big.txt");
    git(dir, "commit", "-qm", "Big file");
    const kept = deleteAt === undefined ? base : base.filter((_, i) => i !== deleteAt && i !== deleteAt + 1);
    const added = Array.from({ length: lines }, (_, i) => `added ${String(i).padStart(6, "0")} ${"x".repeat(64)}`);
    writeFileSync(join(dir, "big.txt"), `${[...kept, ...added].join("\n")}\n`);
    return dir;
  }

  it("22, 23. a reviewer that never opens a file still completes: the corrections carry the ranges, two rounds and never a third", async () => {
    const driver = fake([good]);
    expect(await review(bigChange(Math.round(DELIVER_LINES * 1.5)), driver)).toBe(0);
    expect(driver.sent).toHaveLength(3);
    expect(driver.sent[1]).toMatch(/big\.txt lines 21 to/);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("complete");
    expect(report.completion?.coverage.unread).toEqual([]);
  });

  it("22. a deletion outside the brief is never delivered (its lines live only in git objects): named as unread", async () => {
    expect(await review(bigChange(3000, 5), fake([good]))).toBe(2);
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toMatch(/big\.txt:5-6/);
  });

  it("22, 24. a change too large for the rounds ends incomplete, names what was left, keeps the checked findings and writes no receipt", async () => {
    const driver = fake([good]);
    const dir = bigChange(DELIVER_LINES * 3);
    expect(await review(dir, driver)).toBe(2);
    expect(driver.sent).toHaveLength(3);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("incomplete");
    expect(report.completion?.missing.join("\n")).toMatch(/big\.txt:\d+-\d+/);
    expect(report.findings.map((f) => f.title)).toEqual(["Admin function callable by anyone"]);
    const md = readFileSync(join(dir, ".openqodex/reviews", readdirSync(join(dir, ".openqodex/reviews"))[0]!, "report.md"), "utf8");
    expect(md).toContain("Admin function callable by anyone");
    // The home record of an incomplete run says incomplete and carries no
    // verdict: it never counts as a review and never blocks (the push gate's rule).
    const receipts = join(home, "receipts");
    const records = readdirSync(receipts).flatMap((r) => readdirSync(join(receipts, r)).map((f) => JSON.parse(readFileSync(join(receipts, r, f), "utf8")) as { kind: string; verdict: unknown }));
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) expect(r).toMatchObject({ kind: "incomplete", verdict: null });
  });
});

describe("28, 29. a reviewer whose trace is not complete (Codex)", () => {
  function bigChange(lines: number): string {
    const dir = repo();
    writeFileSync(join(dir, "big.txt"), "kept\n");
    git(dir, "add", "big.txt");
    git(dir, "commit", "-qm", "Big file");
    writeFileSync(join(dir, "big.txt"), `kept\n${Array.from({ length: lines }, (_, i) => `added ${String(i).padStart(6, "0")} ${"x".repeat(64)}`).join("\n")}\n`);
    return dir;
  }
  // The stand-in claims a read of the whole file and reports a command that
  // reached outside the snapshot, as Codex's stream may.
  const claims: Answer = (text) => ({
    finalText: submission(text),
    calls: [
      { tool: "Read", input: { file_path: "big.txt" }, ok: true, read: { path: "big.txt", start: 1, lines: 100_000 } },
      { tool: "shell", input: { command: "cat /etc/hosts" }, ok: true, read: null },
    ],
  });
  const untraced = (answers: Answer[]): Fake => Object.assign(fake(answers), { name: "codex", traced: false });
  const runDir = (dir: string) => join(dir, ".openqodex/reviews", readdirSync(join(dir, ".openqodex/reviews"))[0]!);

  it("28. completes from the brief and both delivery rounds, keeps its commands as a diagnostic list, and says reads were not recorded", async () => {
    const driver = untraced([claims]);
    const dir = bigChange(Math.round(DELIVER_LINES * 1.5));
    expect(await review(dir, driver)).toBe(0);
    expect(driver.sent).toHaveLength(3);
    const report = JSON.parse(out) as Report;
    expect(report.completion).toMatchObject({ status: "complete", trace_complete: false, outside_reads: [] });
    expect(report.completion?.coverage.files_read).toEqual([]);
    expect(report.completion?.coverage.files_not_read).toEqual([]);
    const md = readFileSync(join(runDir(dir), "report.md"), "utf8");
    expect(md).toContain("not recorded by Codex");
    expect(md).not.toContain("Files not read");
    expect(readFileSync(join(runDir(dir), "trace.json"), "utf8")).toContain("cat /etc/hosts");
  });

  it("29. ranges the rounds could not carry leave it incomplete, named as not given to the reviewer", async () => {
    const dir = bigChange(DELIVER_LINES * 3);
    expect(await review(dir, untraced([claims]))).toBe(2);
    const report = JSON.parse(out) as Report;
    expect(report.completion?.status).toBe("incomplete");
    expect(report.completion?.missing.join("\n")).toMatch(/not given to the reviewer: big\.txt:\d+-\d+/);
  });
});

describe("25. what a correction message may carry", () => {
  const snap = () => mkdtempSync(join(tmpdir(), "oq-deliver-"));
  const key = () => ["sk", "live", Math.random().toString(36).slice(2).padEnd(24, "z")].join("_");

  it("never sends a secret a redaction left in the snapshot: nothing is delivered and the leak is flagged", () => {
    const dir = snap();
    const secret = key();
    writeFileSync(join(dir, "a.py"), `x = 1\nKEY = "${secret}"\n`);
    const r = deliverRanges({ snapshotDir: dir, unread: [{ path: "a.py", start: 2, end: 2, deletion: false }], secrets: [secret] });
    expect(r.text).not.toContain(secret);
    expect(r.leak).toBe(true);
    expect(r.delivered).toEqual([]);
  });

  it("never delivers a deletion (it would come from git objects), a dropped file, a binary file or a very long line", () => {
    const dir = snap();
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0, 1, 2, 10, 3, 10]));
    writeFileSync(join(dir, "long.js"), `${"a".repeat(20_000)}\n`);
    const unread = [
      { path: "gone.py", start: 1, end: 1, deletion: false },
      { path: "bin.dat", start: 1, end: 2, deletion: false },
      { path: "long.js", start: 1, end: 1, deletion: false },
      { path: "bin.dat", start: 3, end: 4, deletion: true },
    ];
    const r = deliverRanges({ snapshotDir: dir, unread, secrets: [] });
    expect(r.delivered).toEqual([]);
    expect(r.left).toHaveLength(4);
    expect(r.text).toBe("");
  });

  it("a planted secret in an unread range never reaches the correction the reviewer gets", async () => {
    const gitleaks = installedGitleaks();
    if (gitleaks === null) return void process.stdout.write("correction secret: skipped, gitleaks is not installed\n");
    const dir = repo();
    const secret = `sk_live_${Array.from({ length: 24 }, (_, i) => "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"[(i * 7 + Math.floor(Math.random() * 57)) % 57]).join("")}`;
    writeFileSync(join(dir, "big.py"), `${Array.from({ length: 3000 }, (_, i) => `value_${i} = "${"y".repeat(70)}"`).join("\n")}\nSTRIPE_KEY = "${secret}"\n`);
    cpSync(gitleaks, join(home, "tools/gitleaks"), { recursive: true });
    const driver = fake([good]);
    const { global } = parseFlags(["--cwd", dir, "--no-color", "--format", "json", "--no-install"], {});
    await runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint,gitleaks", reviewer: "auto", timeoutMs: 60_000, drivers: [driver] });
    expect(driver.sent.length).toBeGreaterThan(1);
    expect(driver.sent.join("\n")).not.toContain(secret);
    expect(driver.sent.slice(1).join("\n")).toContain("STRIPE_KEY");
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
    expect(redactSnapshot(dir, [secret])).toEqual({ redacted: 2, removed: [], named: 0 });
    expect(readFileSync(join(dir, "app/config.py"), "utf8")).not.toContain(secret);
    expect(readFileSync(join(dir, "app/other.py"), "utf8")).toBe("# copied: [redacted]\nx = 1\n");
  });
  it("19. masks a multi-line secret line by line, so every line below it keeps its number", () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-redact-lines-"));
    const body = Array.from({ length: 3 }, () => Math.random().toString(36).slice(2).padEnd(40, "q")).join("\n");
    // The markers are joined at run time, so this file holds no key-shaped text.
    const mark = (word: string) => ["-----", word, " PRIVATE ", "KEY-----"].join("");
    const key = `${mark("BEGIN")}\n${body}\n${mark("END")}`;
    const text = `KEY = """\n${key}\n"""\ncheck(user)  # line 8\n`;
    writeFileSync(join(dir, "keys.py"), text);
    redactSnapshot(dir, [key]);
    const after = readFileSync(join(dir, "keys.py"), "utf8");
    expect(after).not.toContain(body.split("\n")[0]);
    expect(after.split("\n")).toHaveLength(text.split("\n").length);
    expect(after.split("\n")[7]).toBe("check(user)  # line 8");
  });
  it("16. overwrites a secret inside a binary file too", () => {
    const dir = mkdtempSync(join(tmpdir(), "oq-redact-bin-"));
    const secret = ["sk", "live", Math.random().toString(36).slice(2).padEnd(24, "y")].join("_");
    writeFileSync(join(dir, "blob.bin"), Buffer.concat([Buffer.from([0, 255, 254, 0]), Buffer.from(secret), Buffer.from([0, 1])]));
    expect(redactSnapshot(dir, [secret]).redacted).toBe(1);
    expect(readFileSync(join(dir, "blob.bin")).includes(Buffer.from(secret))).toBe(false);
  });
});

describe("the reviewer process", () => {
  it("20. never runs a claude that resolves inside the repository, however PATH reaches it", async () => {
    const dir = repo();
    const marker = join(mkdtempSync(join(tmpdir(), "oq-marker-")), "ran");
    const plant = (folder: string) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "claude"), `#!/bin/sh\necho ran >> '${marker}'\necho 9.9.9\n`);
      chmodSync(join(folder, "claude"), 0o755);
    };
    plant(join(dir, "bin"));
    plant(join(dir, "..tools"));
    const outside = mkdtempSync(join(tmpdir(), "oq-path-"));
    symlinkSync(join(dir, "bin"), join(outside, "linked"));
    mkdirSync(join(outside, "single"));
    symlinkSync(join(dir, "bin/claude"), join(outside, "single/claude"));
    vi.stubEnv("PATH", [join(outside, "linked"), join(dir, "..tools"), join(outside, "single")].join(":"));
    const found = await claudeDriver.detect(dir);
    expect(found.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
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

const fallback = (dir: string, rest = "") => `To review with the agent you are in instead, run \`npx -y openqodex@0.0.0-test review --agent --cwd '${dir}'${rest}\` and follow the brief it prints.`;
const SAME_AGENT = "Reviewed by the coding agent you are using.";

describe("26. the fallback when no reviewer can start", () => {
  it("with no driver available the message names the fallback command", async () => {
    const dir = repo();
    expect(await review(dir, fake([good], false))).toBe(2);
    expect(err).toContain("Full review unavailable");
    expect(err).toContain(fallback(dir));
  });

  it("the fallback command keeps the folder and the network limits of the run it replaces", async () => {
    const dir = repo();
    expect(await review(dir, fake([good], false), ["--offline", "--no-install"])).toBe(2);
    expect(err).toContain(fallback(dir, " --offline --no-install"));
  });

  it("with a driver available the fallback text never appears", async () => {
    expect(await review(repo(), fake([good]))).toBe(0);
    expect(out + err).not.toContain("review --agent");
    expect(out + err).not.toContain("To review with the agent you are in");
  });
});

describe("27. a fallback review", () => {
  it("ends with a legacy record and names the reviewing agent in every output format", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    // Everything an agent with only the brief needs to finish.
    for (const part of ["## How to review", "## Finding shape", "`dropped`: one entry per candidate", join(s.repo, latest.dir, "agent-findings.json"), "review --finalize", "Show the developer the report finalize prints"]) {
      expect(brief.stdout).toContain(part);
    }
    const findings = { version: 1, change_id: latest.change_id, summary: "Adds a notes file.", reviewer: "same-agent", findings: [] };
    writeFileSync(join(s.repo, latest.dir, "agent-findings.json"), JSON.stringify(findings));
    const done = cli(s, ["review", "--finalize", "--no-color"]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout.split("\n")[1]).toBe(SAME_AGENT);
    const dir = join(s.repo, latest.dir);
    const md = readFileSync(join(dir, "report.md"), "utf8").split("\n").filter((l) => l !== "");
    expect(md[md.findIndex((l) => l.startsWith("**")) + 1]).toBe(SAME_AGENT);
    expect((JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as { reviewed_by?: string }).reviewed_by).toBe(SAME_AGENT);
    const sarif = JSON.parse(readFileSync(join(dir, "report.sarif"), "utf8")) as { runs: { properties?: { reviewed_by?: string } }[] };
    expect(sarif.runs[0]?.properties?.reviewed_by).toBe(SAME_AGENT);
    expect(readHomeReceipt(s.oqHome, s.repo, "latest")?.kind).toBe("legacy");
  });
});
