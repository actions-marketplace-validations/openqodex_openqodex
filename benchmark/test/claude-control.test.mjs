// Failure list, written before implementation:
// 1. Control dispatch runs OpenQodex or sends its brief instead of the native command.
// 2. A native review body is shortened or rewritten into engine findings.
// 3. A sample loses command, CLI version, served model, time or cost.
// 4. Requested models or missing usage are recorded as served models, or
//    a requested model that differs from usage loses its mismatch record.
// 5. A failed native review looks complete or loses its native output.
// 6. The control is run twice under graph settings it does not use.
// 7. Settings omit the trusted Bash gate or disable it, or lose the tool fences.
// 8. Git inherits global or system config, hooks, a file monitor or SSH access.
// 9. Case titles, bodies or paths enter shell code or arguments, or lose bytes.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CONTROL_PROMPT, controlEnv, controlSample, nativeReviewBody } from "../lib/claude-control.mjs";
import { claudeRunModels, laptopInvocation, planJobs } from "../lib/runner.mjs";

const job = { jobId: "planted/test@abcdef01/control-graph-off/1", caseId: "planted/test@abcdef01", case: "test", config: "control-graph-off", reviewer: "control", graph: false, repeat: 1 };
const body = "## Review\n\nKeep  all whitespace.\n```js\nthrow new Error('bug');\n```\n" + "Native detail.\n".repeat(100);
const answer = { result: body, is_error: false, modelUsage: { "served-model": { inputTokens: 42, outputTokens: 7 } }, usage: { input_tokens: 42, output_tokens: 7 }, num_turns: 3, total_cost_usd: 0.12 };
const invocation = laptopInvocation({ cli: "/built/dist/bin.js", repo: "/case", reportDir: "/sample/report", job, web: "off", timeout: 60, maxUsd: 0.8 });
const sample = (native = answer) => controlSample({ job, attempt: 1, result: { code: native.is_error ? 1 : 0, signal: null, stdout: JSON.stringify(native), stderr: "", wallMs: 1234 }, command: invocation, version: "2.1.296", startedAt: "2026-10-14T00:00:00Z" });

it("dispatches control directly to Claude Code's native review command without a brief", () => {
  expect(invocation.command).toBe("claude");
  expect(invocation.input).toBe(CONTROL_PROMPT);
  expect(CONTROL_PROMPT).toBe("/code-review medium");
  expect(invocation.args).not.toContain("/built/dist/bin.js");
  expect(invocation.args).not.toContain("--disable-slash-commands");
  expect(invocation.args).toContain("--max-budget-usd");
  expect(JSON.stringify(invocation)).not.toMatch(/brief|report-dir|scanner|graph/i);
});
it("wires the trusted Bash gate without losing the settings or tool fences", () => {
  const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
  const gate = fileURLToPath(new URL("../lib/control-gate.mjs", import.meta.url));
  expect(settings).toEqual({ autoMemoryEnabled: false, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `'${process.execPath.replaceAll("'", "'\\''")}' '${gate.replaceAll("'", "'\\''")}'`, onFailure: "block" }] }] } });
  expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
  expect(invocation.args[invocation.args.indexOf("--allowedTools") + 1]).toBe("Read,Grep,Glob,Bash(git diff*),Bash(git status*),Bash(git log*),Bash(git show*),Bash(git rev-parse*)");
  const result = spawnSync(settings.hooks.PreToolUse[0].hooks[0].command, { shell: true, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git diff; id" } }), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
});
it("isolates Git config and overrides hooks, file monitors and SSH in the real environment", () => {
  const env = controlEnv({ PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/untrusted", GIT_CONFIG_SYSTEM: "/untrusted", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/untrusted" });
  expect(env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "3" });
  for (const [key, value] of [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["core.sshCommand", "/usr/bin/false"]]) {
    const result = spawnSync("git", ["config", "--get", key], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(value);
  }
});
it("delivers a case title with a shell operator and quote unchanged through stdin", () => {
  const caseData = { title: 'Fix "value"; id', body: "Text with $(id), `id` and a newline\nkept.", paths: ['src/a"; id.ts', "src/a b.ts"] };
  const call = laptopInvocation({ job, maxUsd: 0.8, caseData });
  expect(call.command).toBe("claude");
  expect(call.args).toEqual(invocation.args);
  // A real stdin reader checks transport without replacing Claude or spending on a review.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", 'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(0));'], { input: call.input, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.startsWith(`${CONTROL_PROMPT}\n`)).toBe(true);
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("\n") + 1))).toEqual(caseData);
});
it("keeps the native body whole without a brief or engine output", () => {
  const s = sample();
  expect(s.nativeBody).toBe(body);
  for (const key of ["brief", "report", "findings", "scanners", "graphStatus", "timings"]) expect(s).not.toHaveProperty(key);
  expect(nativeReviewBody(s)).toBe(body);
  expect(nativeReviewBody({ reviewer: "claude" })).toBe(null);
});
it("records command, version, served model, time and cost from native usage", () => {
  expect(sample()).toMatchObject({ command: invocation, reviewerUsed: { name: "claude", version: "2.1.296" }, model: "served-model", models: ["served-model"], modelStatus: "known", started_at: "2026-10-14T00:00:00Z", wallMs: 1234, usage: { input_tokens: 42, output_tokens: 7, cost_usd: 0.12 }, status: "complete" });
});
it("records missing and mixed usage without inventing a served model", () => {
  expect(sample({ ...answer, modelUsage: {} })).toMatchObject({ model: null, modelStatus: "none" });
  expect(sample({ ...answer, modelUsage: { first: {}, second: {} } })).toMatchObject({ model: ["first", "second"], modelStatus: "mixed" });
});
it("keeps the usage model and records a mismatch with the requested model", () => {
  const s = sample();
  const observed = claudeRunModels([s], "requested-model", "control");
  expect(s.model).toBe("served-model");
  expect(observed).toMatchObject({ model: "served-model", why: "Claude Code requested model requested-model, but samples were served by served-model" });
});
it("keeps a failed review's body and refuses to mark it complete", () => {
  expect(sample({ ...answer, is_error: true })).toMatchObject({ status: "failed", nativeBody: body });
});
it("refuses graph-on configurations for a control reviewer", () => {
  expect(() => planJobs({ cases: ["test"], caseIds: { test: job.caseId }, reviewers: ["control"], graph: ["on"], repeat: 1 })).toThrow(/control.*graph/);
});
it("accepts --reviewers control without launching a paid probe on a dry run", () => {
  const r = spawnSync(process.execPath, ["benchmark/run.mjs", "--reviewers", "control", "--cases", "ts-removed-export", "--repeat", "1", "--max-usd", "0.8", "--max-minutes", "2", "--dry-run"], { encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("control-graph-off");
  expect(r.stdout).not.toContain("Scanners:");
});
