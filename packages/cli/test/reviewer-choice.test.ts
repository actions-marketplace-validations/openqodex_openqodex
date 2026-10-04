// Which reviewer `review` starts, and with which tools: the --reviewer flag,
// the `reviewer:` and `reviewer_web:` keys of the user config
// (<openqodex home>/config.yaml), and `auto`. The Codex and Cursor drivers
// are this repo's own modules; the reviewer model is the one stand-in, a
// driver object that answers with a recorded submission.
//
// Ways it could fail, written before the code:
//  1. `auto` picks a driver that is not enabled (Cursor).
//  2. `--reviewer codex` run from inside Codex's own sandbox, where a nested
//     Codex cannot start, crashes or hangs instead of saying "Full review
//     unavailable" with the reason and the fallback command.
//  8. `auto` inside Claude Code does not pick Claude Code, though Codex is
//     installed too.
//  9. `auto` with only Codex available does not pick Codex.
// 10. `auto` inside a Codex session does not pick Codex first.
//  3. The config's `reviewer:` key is ignored.
//  4. The flag does not win over the config.
//  5. The reviewer gets web tools with the default config.
//  6. `reviewer_web: on` does not give Claude Code its web tools, or the
//     trace check then fails the run for using them.
//  7. A config value that is neither a known reviewer nor on or off is
//     silently ignored.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Report } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { claudeArgs } from "../src/reviewers/claude.js";
import { codexDriver } from "../src/reviewers/codex.js";
import { cursorDriver } from "../src/reviewers/cursor.js";
import { DEPTH_ENV } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { DEFAULT_REVIEWER_WEB } from "../src/reviewers/settings.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

// A repo with one commit and an uncommitted text file: no scanner candidate.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-choice-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "Base");
  writeFileSync(join(dir, "notes.txt"), "one line\n");
  return dir;
}

type Fake = ReviewerDriver & { starts: { web: boolean }[] };

// The model provider stand-in: reads the changed file, then answers with an
// empty, valid submission. `calls` adds tool calls to the answer. `name`
// and `available` make it stand in for another agent, or for one that is
// not installed.
function fake(calls: Turn["calls"] = [], name = "claude", available = true): Fake {
  const driver: Fake = {
    name,
    traced: name === "claude",
    starts: [],
    async detect() {
      return available ? { ok: true as const, version: "9.9.9", bin: `/fake/${name}` } : { ok: false as const, missing: `${name} is not installed`, fix: `install ${name}` };
    },
    start(opts): ReviewerSession {
      driver.starts.push({ web: opts.web });
      return {
        pid: 4242,
        async send(text: string): Promise<Turn> {
          const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
          const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Adds a notes file.", findings: [], dropped: [] });
          const read = { tool: "Read", input: { file_path: "notes.txt" }, ok: true, read: { path: "notes.txt", start: 1, lines: 1 } };
          return { finalText, calls: [read, ...calls], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "fake", failure: null };
        },
        async close() {},
      };
    },
  };
  return driver;
}

let out: string;
let err: string;
let home: string;
beforeEach(() => {
  out = "";
  err = "";
  home = mkdtempSync(join(tmpdir(), "oq-choice-home-"));
  vi.stubEnv("OPENQODEX_HOME", home);
  vi.stubEnv(DEPTH_ENV, "");
  // The agent running the tests must not decide `auto`.
  vi.stubEnv("CLAUDECODE", "");
  vi.stubEnv("CODEX_THREAD_ID", "");
  vi.stubEnv("CODEX_SANDBOX", "");
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function userConfig(text: string): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.yaml"), text);
}

function review(drivers: ReviewerDriver[], reviewer?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", repo(), "--no-color", "--format", "json"], {});
  return runReview({ flags: global, scope: {}, noGraph: true, only: "sqllint", reviewer, timeoutMs: 60_000, drivers });
}

describe("choosing the reviewer", () => {
  it("1. auto passes by Cursor, which is not enabled, and starts Claude Code", async () => {
    const claude = fake();
    expect(await review([cursorDriver, claude])).toBe(0);
    expect(claude.starts).toHaveLength(1);
    expect((JSON.parse(out) as Report).completion?.reviewer?.driver).toBe("claude");
  });

  it("2. --reviewer codex inside Codex's own sandbox exits 2 with Full review unavailable, the reason and the fallback command", async () => {
    vi.stubEnv("CODEX_SANDBOX", "seatbelt");
    const claude = fake();
    expect(await review([codexDriver, cursorDriver, claude], "codex")).toBe(2);
    expect(claude.starts).toHaveLength(0);
    expect(err).toContain("Full review unavailable");
    expect(err).toMatch(/codex: Codex cannot start a second Codex inside its own sandbox/);
    expect(err).toMatch(/review --agent/);
  });

  it("8. auto inside Claude Code picks Claude Code, with Codex available too", async () => {
    vi.stubEnv("CLAUDECODE", "1");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([codex, claude])).toBe(0);
    expect(claude.starts).toHaveLength(1);
    expect(codex.starts).toHaveLength(0);
  });

  it("9. auto with only Codex available picks Codex, and the report names it", async () => {
    const codex = fake([], "codex");
    expect(await review([fake([], "claude", false), codex])).toBe(0);
    expect(codex.starts).toHaveLength(1);
    const completion = (JSON.parse(out) as Report).completion;
    expect(completion?.reviewer?.driver).toBe("codex");
    expect(completion?.trace_complete).toBe(false);
  });

  it("10. auto inside a Codex session picks Codex before Claude Code", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "00000000-0000-0000-0000-000000000001");
    const codex = fake([], "codex");
    const claude = fake();
    expect(await review([claude, codex])).toBe(0);
    expect(codex.starts).toHaveLength(1);
    expect(claude.starts).toHaveLength(0);
  });

  it("3. the config's reviewer: key picks the driver", async () => {
    userConfig("reviewer: cursor\n");
    const claude = fake();
    expect(await review([codexDriver, cursorDriver, claude])).toBe(2);
    expect(claude.starts).toHaveLength(0);
    expect(err).toMatch(/cursor: not enabled/);
  });

  it("4. --reviewer wins over the config", async () => {
    userConfig("reviewer: codex\n");
    const claude = fake();
    expect(await review([codexDriver, claude], "claude")).toBe(0);
    expect(claude.starts).toHaveLength(1);
  });

  it("7. a reviewer: or reviewer_web: value openqodex does not know stops the run and names the file", async () => {
    userConfig("reviewer: gemini\n");
    await expect(review([fake()])).rejects.toThrow(/config\.yaml.*reviewer/);
    userConfig("reviewer_web: sometimes\n");
    await expect(review([fake()])).rejects.toThrow(/config\.yaml.*reviewer_web/);
  });
});

describe("web tools", () => {
  it("5. the default is off, and with it the reviewer has no web tool", async () => {
    expect(DEFAULT_REVIEWER_WEB).toBe("off");
    const claude = fake();
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: false }]);
    const tools = claudeArgs(false)[claudeArgs(false).indexOf("--tools") + 1];
    expect(tools).toBe("Read,Grep,Glob");
  });

  it("6. reviewer_web: on gives Claude Code WebSearch and WebFetch, and a run that uses them completes", async () => {
    userConfig("reviewer_web: on\n");
    const web = [{ tool: "WebSearch", input: { query: "flask pagination" }, ok: true, read: null }];
    const claude = fake(web);
    expect(await review([claude])).toBe(0);
    expect(claude.starts).toEqual([{ web: true }]);
    expect((JSON.parse(out) as Report).completion?.status).toBe("complete");
    expect(claudeArgs(true)[claudeArgs(true).indexOf("--tools") + 1]).toBe("Read,Grep,Glob,WebSearch,WebFetch");
  });

  it("5. with web off, a web tool call makes the run incomplete", async () => {
    const web = [{ tool: "WebFetch", input: { url: "https://example.com", prompt: "read" }, ok: true, read: null }];
    expect(await review([fake(web)])).toBe(2);
    expect((JSON.parse(out) as Report).completion?.missing.join("\n")).toContain("WebFetch");
  });
});
