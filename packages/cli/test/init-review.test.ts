// `init` ends with a review: of the change when there is one, else one
// question (or, without a terminal, the three commands). The closing step
// runs in-process after the install boundary is released; its own tests
// give it the one stand-in, a reviewer driver object, and the subprocess
// tests run the built CLI with no reviewer on PATH.
//
// Ways it could fail, written before the code:
//  1. `init` with a change prints no report.
//  2. `init` fails (exit not 0) because the review was unavailable.
//  3. `init --yes`, or init without a terminal, with no change waits for an
//     answer instead of printing the three commands.
//  4. A review started by init re-enters init or starts an install step.
//  5. `--no-review` still reviews.
//  6. A dry run or an uninstall reviews.
//  7. A developer's own earlier edit to a file init then wrote to (CLAUDE.md)
//     is left out of the review, or init's own addition is reviewed with it.
//  8. A file init wrote inside the git folder (the pre-push hook, the
//     exclude file) is handed to the change source, git refuses to stage it,
//     and the review after init never runs.
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewAfterInit } from "../src/commands/init-review.js";
import { DEPTH_ENV } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { cli, sandbox } from "./init-helpers.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function repo(change: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-init-review-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  if (change) writeFileSync(join(dir, "notes.txt"), "one line\n");
  return dir;
}

// The model provider stand-in: an empty, valid submission after reading the change.
function fake(): ReviewerDriver & { started: number } {
  const driver = {
    name: "claude",
    traced: true,
    started: 0,
    async detect() {
      return { ok: true as const, version: "9.9.9", bin: "/fake/claude" };
    },
    start(): ReviewerSession {
      driver.started++;
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds a notes file.", findings: [], dropped: [] });
          return { finalText, calls: [{ tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "fake", failure: null };
        },
        async close() {},
      };
    },
  };
  return driver;
}

let out: string;
let err: string;
beforeEach(() => {
  out = "";
  err = "";
  vi.stubEnv("OPENQODEX_HOME", mkdtempSync(join(tmpdir(), "oq-init-review-home-")));
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("the review init ends with", () => {
  it("1. with a change, prints the standard report of a complete review", async () => {
    const driver = fake();
    await reviewAfterInit({ repoRoot: repo(true), runner: "openqodex", interactive: false, drivers: [driver] });
    expect(driver.started).toBe(1);
    expect(out).toContain("Passed");
    expect(out).toContain("Reviewer: claude 9.9.9");
  });

  it("3. with no change and no terminal, prints the three commands and asks nothing", async () => {
    const driver = fake();
    const ask = vi.fn();
    await reviewAfterInit({ repoRoot: repo(false), runner: "openqodex", interactive: false, drivers: [driver], ask });
    expect(ask).not.toHaveBeenCalled();
    expect(driver.started).toBe(0);
    expect(out).toContain("openqodex review --all");
    expect(out).toContain("openqodex review '#<number>'");
    expect(out).toContain("openqodex review <branch>");
  });

  it("with no change and a terminal, asks one question and reviews the whole repo when that is the answer", async () => {
    const driver = fake();
    const ask = vi.fn(async () => ({ kind: "all" as const }));
    await reviewAfterInit({ repoRoot: repo(false), runner: "openqodex", interactive: true, drivers: [driver], ask });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(driver.started).toBe(1);
  });

  it("with no change and the answer not now, reviews nothing", async () => {
    const driver = fake();
    await reviewAfterInit({ repoRoot: repo(false), runner: "openqodex", interactive: true, drivers: [driver], ask: async () => null });
    expect(driver.started).toBe(0);
  });

  it("2. a review that cannot start is reported and never throws", async () => {
    const none: ReviewerDriver = { name: "claude", traced: true, detect: async () => ({ ok: false, missing: "claude is not installed", fix: "install it" }), start: () => { throw new Error("no"); } };
    await expect(reviewAfterInit({ repoRoot: repo(true), runner: "openqodex", interactive: false, drivers: [none] })).resolves.toBeUndefined();
    expect(err).toContain("Full review unavailable");
  });
});

// PATH with every folder that holds a `claude` program left out.
const noClaude = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "" && !existsSync(join(d, "claude"))).join(delimiter);

// The model provider stand-in for a subprocess run: a `claude` on PATH that
// answers detection as Claude Code does, then answers every message with an
// empty, valid submission for the change id the brief names.
function standIn(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-init-review-bin-"));
  writeFileSync(
    join(dir, "claude"),
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }",
      "if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
      "let id = 'missing';",
      "const say = (e) => process.stdout.write(JSON.stringify(e) + '\\n');",
      "say({ type: 'system', subtype: 'init', session_id: 'fake', tools: ['Glob', 'Grep', 'Read'], mcp_servers: [] });",
      "let buf = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buf += chunk;",
      "  for (let nl = buf.indexOf('\\n'); nl !== -1; nl = buf.indexOf('\\n')) {",
      "    const text = JSON.parse(buf.slice(0, nl)).message.content;",
      "    buf = buf.slice(nl + 1);",
      "    id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? id;",
      "    const result = JSON.stringify({ version: 2, change_id: id, summary: 'Adds a notes file.', findings: [], dropped: [] });",
      "    say({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result });",
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  chmodSync(join(dir, "claude"), 0o755);
  return dir;
}

describe("init as a subprocess", () => {
  it("2, 4. with a change and no reviewer: exit 0, says the review is unavailable, prints the plan once", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { env: { PATH: noClaude }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("Full review unavailable");
    expect(r.stdout.match(/install plan/g)).toHaveLength(1);
    expect(r.stderr + r.stdout).not.toMatch(/Installing the scanners .* first use|downloading/i);
  });

  it("8. with the git pre-push hook and an exclude line written, the review after init still runs", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--agent", "cursor", "--hook", "pre-push", "--no-repo"], { env: { PATH: `${standIn()}${delimiter}${noClaude}` }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(s.repo, ".git/hooks/pre-push"))).toBe(true);
    expect(readFileSync(join(s.repo, ".git/info/exclude"), "utf8")).toContain(".cursor");
    expect(r.stderr).not.toContain("did not run");
    expect(r.stdout).toContain("Reviewer: claude 9.9.9");
  });

  it("3. --yes with no change prints the three commands and exits without waiting", () => {
    const s = sandbox({ "README.md": "hello\n" });
    const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo"], { env: { PATH: noClaude }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("No change to review here");
    expect(r.stdout).toContain("review <branch>");
  });

  it("5. --no-review skips the review", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    const r = cli(s, ["init", "--yes", "--no-review", "--agent", "claude-code", "--hook", "none", "--no-repo"], { env: { PATH: noClaude }, review: true });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("Full review unavailable");
    expect(r.stdout).not.toContain("Reviewing your change now");
  });

  it("6. a dry run and an uninstall review nothing", () => {
    const s = sandbox({ "README.md": "hello\n" });
    writeFileSync(join(s.repo, "notes.txt"), "one line\n");
    for (const extra of [["--dry-run"], ["--uninstall"]]) {
      const r = cli(s, ["init", "--yes", "--agent", "claude-code", "--hook", "none", "--no-repo", ...extra], { env: { PATH: noClaude }, review: true });
      expect(r.stderr).not.toContain("Full review unavailable");
      expect(r.stdout).not.toContain("Reviewing your change now");
      expect(r.stdout).not.toContain("No change to review here");
    }
  });
});

describe("7. what init wrote is not part of the first review", () => {
  // A stand-in that keeps what the snapshot held when it started.
  function seeing(path: string): ReviewerDriver & { seen: (string | null)[] } {
    const d = fake() as ReviewerDriver & { seen: (string | null)[]; started: number };
    d.seen = [];
    const start = d.start.bind(d);
    d.start = (opts) => {
      d.seen.push(existsSync(join(opts.snapshotDir, path)) ? readFileSync(join(opts.snapshotDir, path), "utf8") : null);
      return start(opts);
    };
    return d;
  }

  it("reviews the developer's own edit to CLAUDE.md without the section init appended", async () => {
    const dir = repo(false);
    writeFileSync(join(dir, "CLAUDE.md"), "# Team\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "Claude file");
    const mine = "# Team\n\nUse tabs.\n";
    writeFileSync(join(dir, "CLAUDE.md"), mine);
    appendFileSync(join(dir, "CLAUDE.md"), "\n<!-- openqodex -->\nReview before you push.\n");
    const driver = seeing("CLAUDE.md");
    await reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [driver], initFiles: new Map([[join(dir, "CLAUDE.md"), mine]]) });
    expect(driver.seen).toEqual([mine]);
  });

  it("a file init created is the whole change: nothing is reviewed", async () => {
    const dir = repo(false);
    writeFileSync(join(dir, "AGENTS.md"), "<!-- openqodex -->\nReview before you push.\n");
    const driver = seeing("AGENTS.md");
    await reviewAfterInit({ repoRoot: dir, runner: "openqodex", interactive: false, drivers: [driver], initFiles: new Map([[join(dir, "AGENTS.md"), null]]) });
    expect(driver.seen).toEqual([]);
    expect(out).toContain("No change to review here");
  });
});
