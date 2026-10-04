// The record the push hooks trust lives in the developer's own OpenQodex
// home (<home>/receipts/<repo id>/<change id>.json), written by `review` at
// the end of a run. The reviewer model is the one stand-in: a driver object.
//
// Ways it could fail, written before the code:
//  1. A complete review run writes no record in the home, so the hook keeps
//     asking for a review that was done.
//  2. The record is readable by other users.
//  3. A target review (someone else's branch) writes a record that a push of
//     the developer's own change could match.
//  4. Records never go away: init does not prune those older than 30 days,
//     or prunes fresh ones.
//  5. The legacy `review --finalize` trusts a run's manifest, scan and
//     findings files in the repository folder, which a branch can carry, and
//     writes a home record for a run whose scan never ran on this machine, or
//     whose scan.json was edited after `review --agent` wrote it.
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getChange } from "@openqodex/core";
import { parseFlags } from "../src/flags.js";
import { runReview } from "../src/review-run.js";
import { homeReceiptPath, homeRunPath, readHomeReceipt } from "../src/receipts.js";
import { DEPTH_ENV } from "../src/reviewers/driver.js";
import type { ReviewerDriver, ReviewerSession, Turn } from "../src/reviewers/driver.js";
import { cli, sandbox, type Sandbox } from "./init-helpers.js";

(globalThis as Record<string, unknown>).__OPENQODEX_VERSION__ = "0.0.0-test";

// An empty, valid submission after reading the changed file.
const driver: ReviewerDriver = {
  name: "claude",
  detect: async () => ({ ok: true, version: "9.9.9", bin: "/fake/claude" }),
  start(): ReviewerSession {
    return {
      pid: 1,
      async send(text: string): Promise<Turn> {
        const id = /`change_id`: `([0-9a-f]{12})`/.exec(text)?.[1] ?? "missing";
        const finalText = JSON.stringify({ version: 2, change_id: id, summary: "Edits the readme.", findings: [], dropped: [] });
        return { finalText, calls: [{ tool: "Read", input: { file_path: "README.md" }, ok: true, read: { path: "README.md", start: 1, lines: 1 } }], usage: { turns: 1, input_tokens: 1, output_tokens: 1, cost_usd: null }, sessionId: "f", failure: null };
      },
      async close() {},
    };
  },
};

let s: Sandbox;
beforeEach(() => {
  s = sandbox({ "README.md": "hello\n" });
  vi.stubEnv("OPENQODEX_HOME", s.oqHome);
  vi.stubEnv(DEPTH_ENV, "");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function review(target?: string): Promise<number> {
  const { global } = parseFlags(["--cwd", s.repo, "--no-color", "--format", "json", "--no-install", ...(target ? ["--offline"] : [])], {});
  return runReview({ flags: global, scope: {}, target, base: target ? "main" : undefined, noGraph: true, timeoutMs: 60_000, drivers: [driver] });
}

function check(): string {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, cwd: s.repo });
  const r = cli(s, ["hook", "check"], { input });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe("the home record", () => {
  it("1, 2. a complete review writes a 0600 record in the home, and the agent hook is silent for that change", async () => {
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    expect(await review()).toBe(0);
    const change = await getChange({ repoRoot: s.repo, scope: {}, exclude: [] });
    expect(readHomeReceipt(s.oqHome, s.repo, change.id)?.kind).toBe("complete");
    expect(statSync(homeReceiptPath(s.oqHome, s.repo, change.id)).mode & 0o777).toBe(0o600);
    expect(check()).toBe("");
  });

  it("3. a review of another branch writes no record", async () => {
    const { spawnSync } = await import("node:child_process");
    const g = (...a: string[]) => spawnSync("git", a, { cwd: s.repo, encoding: "utf8" });
    g("checkout", "-q", "-b", "other");
    writeFileSync(join(s.repo, "notes.txt"), "one\n");
    g("add", "-A");
    g("commit", "-q", "-m", "notes");
    g("checkout", "-q", "main");
    expect(await review("other")).not.toBe(2);
    expect(existsSync(join(s.oqHome, "receipts"))).toBe(false);
  });

  it("4. init prunes records older than 30 days and keeps fresh ones", async () => {
    const old = homeReceiptPath(s.oqHome, s.repo, "a".repeat(64));
    const fresh = homeReceiptPath(s.oqHome, s.repo, "b".repeat(64));
    mkdirSync(join(old, ".."), { recursive: true });
    writeFileSync(old, "{}\n");
    writeFileSync(fresh, "{}\n");
    const oldRun = homeRunPath(s.oqHome, s.repo, "20260101-000000-aaaaaaaaaaaa");
    mkdirSync(join(oldRun, ".."), { recursive: true });
    writeFileSync(oldRun, "{}\n");
    const longAgo = (Date.now() - 31 * 24 * 3600_000) / 1000;
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldRun, longAgo, longAgo);
    expect(cli(s, ["init", "--yes", "--hook", "none", "--no-repo", "--agent", "claude-code"]).status).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(oldRun)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("5. the legacy two-step protocol", () => {
  // `review --agent` in this home, then the findings written as the brief says.
  function agentRun(): { dir: string; changeId: string } {
    writeFileSync(join(s.repo, "README.md"), "changed\n");
    const brief = cli(s, ["review", "--agent", "--no-install"]);
    expect(brief.status, brief.stderr).toBe(0);
    const latest = JSON.parse(readFileSync(join(s.repo, ".openqodex/latest.json"), "utf8")) as { dir: string; change_id: string };
    const dir = join(s.repo, latest.dir);
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as { candidates: { id: string }[] };
    const findings = { version: 1, change_id: latest.change_id, summary: "Edits the readme.", reviewer: "subagent", findings: [], dropped: scan.candidates.map((c) => ({ candidate: c.id, reason: "Not actionable here" })) };
    writeFileSync(join(dir, "agent-findings.json"), JSON.stringify(findings));
    return { dir, changeId: latest.change_id };
  }

  it("finalize in the home that ran the scan writes the legacy record", () => {
    const { changeId } = agentRun();
    expect(cli(s, ["review", "--finalize"]).status).toBe(0);
    expect(readHomeReceipt(s.oqHome, s.repo, changeId)?.kind).toBe("legacy");
  });

  it("finalize of a run this home never scanned writes no record and says so in one line", () => {
    const { changeId } = agentRun();
    const other = mkdtempSync(join(tmpdir(), "oq-other-home-"));
    const r = cli(s, ["review", "--finalize"], { env: { OPENQODEX_HOME: other } });
    expect(r.status).toBe(0);
    expect(readHomeReceipt(other, s.repo, changeId)).toBeNull();
    expect(r.stderr).toMatch(/not recorded for the push hooks/);
  });

  it("finalize of a run whose scan.json changed after review --agent writes no record", () => {
    const { dir, changeId } = agentRun();
    const scan = JSON.parse(readFileSync(join(dir, "scan.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "scan.json"), `${JSON.stringify({ ...scan, candidates: [], planted: true }, null, 2)}\n`);
    const r = cli(s, ["review", "--finalize"]);
    expect(readHomeReceipt(s.oqHome, s.repo, changeId)).toBeNull();
    expect(r.stderr).toMatch(/not recorded for the push hooks/);
  });
});
