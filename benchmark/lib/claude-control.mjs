// Failure cases are listed in test/claude-control.test.mjs before this code.
// Claude Code owns this review. No OpenQodex prompt or engine participates.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeEnv } from "./reviewers.mjs";

const exec = promisify(execFile);
export const CONTROL_PROMPT = "/code-review medium";
export const CONTROL_MODEL_FROM = "the usage record Claude Code returned for this review";

// https://code.claude.com/docs/en/code-review#review-a-diff-locally
// In print mode the built-in command waits and returns its findings as text.
export function controlArgs({ maxUsd }) {
  return ["-p", "--output-format", "json", "--permission-mode", "dontAsk",
    "--setting-sources", "", "--settings", JSON.stringify({ autoMemoryEnabled: false, hooks: {}, disableAllHooks: true }),
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence", "--tools", "Read,Grep,Glob,Bash",
    "--allowedTools", "Read,Grep,Glob,Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git show*),Bash(git rev-parse*)",
    "--max-budget-usd", String(maxUsd)];
}

// A login check, never a paid prompt. Keep the same CLI and login environment
// as the existing Claude reviewer, and never save auth status output.
export async function probeControl({ env = process.env } = {}) {
  const e = claudeEnv(env);
  const { stdout } = await exec("claude", ["--version"], { env: e, timeout: 20_000 });
  const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  if (!e.ANTHROPIC_API_KEY) {
    let loggedIn = false;
    try { loggedIn = JSON.parse((await exec("claude", ["auth", "status"], { env: e, timeout: 20_000 })).stdout).loggedIn === true; }
    catch { /* An unavailable login is a refusal, with no paid probe. */ }
    if (!loggedIn) return { ok: false, blocked: true, version, model: null, text: "Claude Code is not logged in" };
  }
  return { ok: true, blocked: false, version, model: null, text: "login available" };
}

export function controlSample({ job, attempt, result, command, version, startedAt, stopped = null }) {
  let native = null;
  try { native = JSON.parse(result.stdout); } catch { /* Keep malformed output whole in the sample. */ }
  const models = Object.keys(native?.modelUsage ?? {}).sort();
  const body = typeof native?.result === "string" ? native.result : result.stdout;
  const complete = result.code === 0 && native?.is_error === false && typeof native.result === "string" && stopped === null;
  return {
    jobId: job.jobId, caseId: job.caseId, firstAttempt: attempt === 1, case: job.case,
    config: job.config, reviewer: "control", graph: "off", repeat: job.repeat, attempt,
    started_at: startedAt, exit: result.code ?? null, signal: result.signal ?? null,
    wallMs: result.wallMs, status: complete ? "complete" : "failed", stopped,
    failure: complete ? null : stopped ?? (body || result.stderr || `Claude Code exited ${result.code}`),
    command, reviewerUsed: { name: "claude", version },
    model: models.length === 1 ? models[0] : models.length > 1 ? models : null, models,
    modelFrom: CONTROL_MODEL_FROM, modelStatus: models.length === 1 ? "known" : models.length > 1 ? "mixed" : "none",
    usage: { turns: native?.num_turns ?? null, input_tokens: native?.usage?.input_tokens ?? null, output_tokens: native?.usage?.output_tokens ?? null, cost_usd: native?.total_cost_usd ?? null },
    nativeBody: body,
  };
}

// Converter stub for W8-6: one native review body, with no parsing or edits.
export const nativeReviewBody = (sample) => sample?.reviewer === "control" && typeof sample.nativeBody === "string" ? sample.nativeBody : null;
