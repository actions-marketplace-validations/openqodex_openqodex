// Claude Code as the reviewer: `claude -p` in the snapshot folder, the brief
// and each correction round as JSON lines on standard input, the event
// stream on standard output as the trace. Every flag below was shown to do
// what its comment says with Claude Code 2.1.289; docs/internal-reviewer-drivers.md
// records the runs.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ReviewerUsage, TraceEntry } from "@openqodex/core";
import { REVIEWER_TOOLS } from "@openqodex/core";
import { DEPTH_ENV, findOnPath, killGroup, spawnGroup } from "./driver.js";
import type { Detected, ReviewerDriver, ReviewerSession, Turn } from "./driver.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_ARGS = [
  "-p",
  // One JSON event per line out, user messages as JSON lines in: the session
  // stays open between answers, so a correction round goes to the same session.
  "--output-format",
  "stream-json",
  "--verbose",
  "--input-format",
  "stream-json",
  // Reading, searching and listing only: no shell, no edits, no web, no subagent.
  "--tools",
  "Read,Grep,Glob",
  // Anything not allowed is refused without a prompt; reads outside the
  // working folder are not allowed.
  "--permission-mode",
  "dontAsk",
  // No user, project or local settings: no CLAUDE.md, no hooks, no plugins,
  // no permission rules of the developer's.
  "--setting-sources",
  "",
  "--settings",
  JSON.stringify({ autoMemoryEnabled: false, hooks: {} }),
  "--strict-mcp-config",
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
  "--disable-slash-commands",
  "--no-session-persistence",
];

// The variables that tie a process to a running Claude Code session. The
// reviewer is a new session, whether or not `review` runs inside one.
const SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_PID",
  "CLAUDE_JOB_DIR",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
];

export function reviewerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, [DEPTH_ENV]: "1" };
  for (const k of SESSION_VARS) delete out[k];
  return out;
}

const DETECT_TIMEOUT_MS = 20_000;

async function detect(repoRoot: string): Promise<Detected> {
  const bin = findOnPath("claude", repoRoot);
  if (bin === null) return { ok: false, missing: "Claude Code (claude) is not on PATH", fix: "install Claude Code and log in, then review again" };
  const env = reviewerEnv();
  let version: string;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { env, timeout: DETECT_TIMEOUT_MS });
    version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  } catch (error) {
    return { ok: false, missing: `claude --version failed: ${String((error as Error).message).split("\n")[0]}`, fix: "reinstall Claude Code" };
  }
  if (env.ANTHROPIC_API_KEY) return { ok: true, version, bin };
  let status: { loggedIn?: unknown } = {};
  try {
    const { stdout } = await execFileAsync(bin, ["auth", "status"], { env, timeout: DETECT_TIMEOUT_MS });
    status = JSON.parse(stdout) as { loggedIn?: unknown };
  } catch (error) {
    const out = (error as { stdout?: string }).stdout;
    try {
      status = JSON.parse(out ?? "") as { loggedIn?: unknown };
    } catch {
      status = {};
    }
  }
  if (status.loggedIn !== true) return { ok: false, missing: `Claude Code ${version} is not logged in`, fix: "run claude once and log in, then review again" };
  return { ok: true, version, bin };
}

type Event = Record<string, unknown> & { type?: string; subtype?: string };
type ToolUse = { name: string; input: Record<string, unknown> };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// The folder a path names, resolved against the snapshot, and whether it is inside it.
function place(snapshot: string, raw: string | null): { path: string | null; inside: boolean } {
  if (raw === null) return { path: null, inside: true };
  const abs = resolve(snapshot, raw.startsWith("~") ? `/${raw}` : raw);
  const rel = relative(snapshot, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  return { path: inside ? rel || "." : raw, inside };
}

// A Glob pattern with an absolute or parent-relative start reads from there.
function globRoot(pattern: string | null): string | null {
  if (pattern === null || !(pattern.startsWith("/") || pattern.startsWith("~") || pattern.startsWith(".."))) return null;
  const cut = pattern.search(/[*?[{]/);
  return cut === -1 ? pattern : dirname(pattern.slice(0, cut) || "/");
}

function traceEntry(snapshot: string, use: ToolUse, result: { is_error?: unknown }, detail: Record<string, unknown> | undefined): TraceEntry {
  const ok = result.is_error !== true;
  const input = use.input;
  if (use.name === "Read") {
    const file = (detail?.file ?? null) as Record<string, unknown> | null;
    const at = place(snapshot, str(file?.filePath) ?? str(input.file_path));
    const start = num(file?.startLine);
    const lines = num(file?.numLines);
    const range: [number, number] | null = ok && start !== null && lines !== null && lines > 0 ? [start, start + lines - 1] : null;
    return { tool: "Read", ...at, range, ok };
  }
  const raw = use.name === "Glob" ? (str(input.path) ?? globRoot(str(input.pattern))) : str(input.path);
  return { tool: use.name, ...place(snapshot, raw), range: null, ok };
}

function start(opts: { snapshotDir: string; deadline: number; bin: string }): ReviewerSession {
  const snapshot = realpathSync(opts.snapshotDir);
  const child = spawnGroup(opts.bin, CLAUDE_ARGS, { cwd: snapshot, env: reviewerEnv() });
  const uses = new Map<string, ToolUse>();
  let trace: TraceEntry[] = [];
  let usage: ReviewerUsage = { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null };
  let sessionId: string | null = null;
  let failure: string | null = null;
  let stderr = "";
  let waiting: ((t: Turn) => void) | null = null;
  let exited = false;

  const finish = (finalText: string, why: string | null): void => {
    const done = waiting;
    waiting = null;
    const turn: Turn = { finalText, trace, usage, sessionId, failure: why };
    trace = [];
    done?.(turn);
  };
  const fail = (why: string): void => {
    failure ??= why;
    killGroup(child);
    finish("", failure);
  };
  const timer = setTimeout(() => fail(`the reviewer timed out at the deadline and was stopped`), Math.max(0, opts.deadline - Date.now()));
  timer.unref();

  const onEvent = (e: Event): void => {
    if (e.type === "system" && e.subtype === "init") {
      sessionId = str(e.session_id);
      const tools = Array.isArray(e.tools) ? (e.tools as unknown[]).map(String) : [];
      const extra = tools.filter((t) => !REVIEWER_TOOLS.includes(t));
      const mcp = Array.isArray(e.mcp_servers) ? e.mcp_servers.length : 0;
      if (extra.length > 0) fail(`the reviewer started with tools it must not have: ${extra.join(", ")}`);
      else if (mcp > 0) fail("the reviewer started with MCP servers");
      else if (e.memory_paths !== undefined && e.memory_paths !== null) fail("the reviewer started with memory turned on");
      return;
    }
    const content = ((e.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "tool_use" && typeof c.id === "string") uses.set(c.id, { name: String(c.name), input: (c.input ?? {}) as Record<string, unknown> });
      }
      return;
    }
    if (e.type === "user" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
        const use = uses.get(c.tool_use_id);
        if (use) trace.push(traceEntry(snapshot, use, c, e.tool_use_result as Record<string, unknown> | undefined));
      }
      return;
    }
    if (e.type === "result") {
      const models = Object.values((e.modelUsage ?? {}) as Record<string, Record<string, unknown>>);
      const sum = (key: string) => (models.length === 0 ? null : models.reduce((n, m) => n + (num(m[key]) ?? 0), 0));
      const input = sum("inputTokens");
      usage = {
        turns: usage.turns + (num(e.num_turns) ?? 0),
        input_tokens: input === null ? null : input + (sum("cacheReadInputTokens") ?? 0) + (sum("cacheCreationInputTokens") ?? 0),
        output_tokens: sum("outputTokens"),
        cost_usd: num(e.total_cost_usd),
      };
      if (e.is_error === true) fail(`the reviewer stopped with an error: ${str(e.result) ?? str(e.subtype) ?? "unknown"}`);
      else finish(str(e.result) ?? "", null);
    }
  };

  let buf = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buf += chunk;
    for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        onEvent(JSON.parse(line) as Event);
      } catch {
        // a line that is not an event: ignored
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.on("error", (e) => fail(`could not start the reviewer: ${e.message}`));
  child.on("exit", (code, signal) => {
    exited = true;
    clearTimeout(timer);
    if (waiting) fail(`the reviewer exited (${signal ?? `exit ${code}`}) before it answered${stderr.trim() ? `: ${stderr.trim().split("\n").pop()}` : ""}`);
  });
  child.stdin?.on("error", () => {
    // the process is gone; its exit reports why
  });

  return {
    pid: child.pid ?? null,
    send(text: string): Promise<Turn> {
      if (failure !== null || exited) return Promise.resolve({ finalText: "", trace: [], usage, sessionId, failure: failure ?? "the reviewer is no longer running" });
      return new Promise((done) => {
        waiting = done;
        child.stdin?.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`);
      });
    },
    async close(): Promise<void> {
      clearTimeout(timer);
      if (exited) return;
      child.stdin?.end();
      const gone = new Promise<void>((done) => child.once("exit", () => done()));
      const grace = new Promise<void>((done) => setTimeout(done, 3_000).unref());
      await Promise.race([gone, grace]);
      // The agent may leave children of its own: the whole group goes.
      killGroup(child);
    },
  };
}

export const claudeDriver: ReviewerDriver = { name: "claude", detect, start };
