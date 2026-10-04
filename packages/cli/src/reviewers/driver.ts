// The reviewer driver seam. A driver starts one coding agent as a separate
// process, with no window, to review one snapshot: it says whether its agent
// is installed and logged in, starts it without a shell in a process group of
// its own, hands it text and returns the agent's final answer with the trace
// of every tool call the agent reported. Nothing a driver returns is trusted
// as a claim: the run checks the trace and the answer with scripts.
//
// One driver exists today (claude.ts). A new one implements the same
// interface and is added to DRIVERS once its isolation was shown with the
// real binary (docs/internal-reviewer-drivers.md).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { ReviewerUsage } from "@openqodex/core";
import type { ToolCall } from "./trace.js";

// Set in every reviewer's environment. A `review` that starts with it set
// refuses: a review never starts another review.
export const DEPTH_ENV = "OPENQODEX_REVIEW_DEPTH";

export type Detected = { ok: true; version: string; bin: string } | { ok: false; missing: string; fix: string };

// One answer of the reviewer. `usage` is the session's total so far.
// `failure` is one plain line when the agent could not answer (it exited,
// it timed out, it started with more than it was given).
// `calls`: every tool call of this answer, as the agent sent it; the run
// decides from them, by script, what was read and where.
export type Turn = { finalText: string; calls: ToolCall[]; usage: ReviewerUsage; sessionId: string | null; failure: string | null };

// An open reviewer. `send` asks for one answer in the same session: the
// brief first, then each correction round. A driver whose agent cannot keep a
// session open starts a new process per send and attaches what it needs.
export interface ReviewerSession {
  readonly pid: number | null;
  send(text: string): Promise<Turn>;
  // Ends the process and every child it started.
  close(): Promise<void>;
}

export interface ReviewerDriver {
  readonly name: string;
  // `repoRoot`: PATH entries inside it are skipped, so a repository cannot
  // put its own program in the reviewer's place.
  detect(repoRoot: string): Promise<Detected>;
  // `deadline`: epoch milliseconds after which the process group is killed.
  start(opts: { snapshotDir: string; deadline: number; bin: string }): ReviewerSession;
}

// Spawned without a shell, as the leader of a new process group, so the
// whole group can be killed at once.
export function spawnGroup(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true, shell: false });
}

export function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is gone already.
  }
}

// The first executable `name` on PATH, from absolute entries outside `repoRoot` only.
export function findOnPath(name: string, repoRoot: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const rel = relative(repoRoot, dir);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) continue;
    const bin = join(dir, name);
    try {
      if (existsSync(bin) && statSync(bin).isFile() && (statSync(bin).mode & 0o111) !== 0) return bin;
    } catch {
      // unreadable entry: try the next
    }
  }
  return null;
}

// The reviewers `--reviewer` accepts, besides `auto`.
export const REVIEWER_NAMES = ["claude"] as const;

// The agent running this command, when its environment says so.
export function hostAgent(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDECODE === "1") return "claude";
  return null;
}
