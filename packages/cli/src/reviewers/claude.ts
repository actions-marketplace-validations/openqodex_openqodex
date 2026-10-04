// Claude Code as the reviewer: `claude -p` in the snapshot folder, the brief
// and each correction round as JSON lines on standard input, the event
// stream on standard output as the trace. Every flag below was shown to do
// what its comment says with Claude Code 2.1.289; docs/internal-reviewer-drivers.md
// records the runs.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewerUsage } from "@openqodex/core";
import { REVIEWER_TOOLS, REVIEWER_WEB_TOOLS } from "@openqodex/core";
import { checkoutsDir } from "../checkout.js";
import { DEPTH_ENV, findOnPath, killGroup, spawnGroup } from "./driver.js";
import type { Detected, ReviewerDriver, ReviewerSession, Turn } from "./driver.js";
import type { ToolCall } from "./trace.js";

const execFileAsync = promisify(execFile);

// `web`: WebSearch and WebFetch are added only when the user config sets
// `reviewer_web: on`.
export function claudeArgs(web: boolean): string[] {
  const tools = web ? [...REVIEWER_TOOLS, ...REVIEWER_WEB_TOOLS] : REVIEWER_TOOLS;
  return [
    "-p",
    // One JSON event per line out, user messages as JSON lines in: the session
    // stays open between answers, so a correction round goes to the same session.
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    // Reading, searching and listing only (and the web, when allowed): no
    // shell, no edits, no subagent.
    "--tools",
    tools.join(","),
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
    // dontAsk refuses the web tools unless they are allowed by name.
    ...(web ? ["--allowedTools", REVIEWER_WEB_TOOLS.join(",")] : []),
  ];
}

// The reviewer's environment, from an allowlist: what Claude Code needs to
// run and to find its login (the keychain needs USER on macOS) and nothing
// else, so no token of the developer's (GITHUB_TOKEN, NPM_TOKEN, cloud keys)
// reaches the agent. Cloud provider variables pass only when the developer
// set Claude Code to use that provider. Nothing ties it to a running Claude
// Code session, whether or not `review` runs inside one.
const ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const ANTHROPIC = /^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL|MODEL|SMALL_FAST_MODEL|CUSTOM_HEADERS|DEFAULT_[A-Z_]+_MODEL)$/;
const PROVIDERS: [string, RegExp][] = [
  ["CLAUDE_CODE_USE_BEDROCK", /^(AWS_[A-Z_]+|ANTHROPIC_BEDROCK_BASE_URL)$/],
  ["CLAUDE_CODE_USE_VERTEX", /^(GOOGLE_[A-Z_]+|GCLOUD_[A-Z_]+|CLOUD_ML_REGION|ANTHROPIC_VERTEX_[A-Z_]+|VERTEX_REGION_[A-Z0-9_]+)$/],
  ["CLAUDE_CODE_USE_FOUNDRY", /^ANTHROPIC_FOUNDRY_[A-Z_]+$/],
];

export function reviewerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const provider = PROVIDERS.some(([flag, re]) => env[flag] && (k === flag || re.test(k)));
    if (ALWAYS.includes(k) || k.startsWith("LC_") || ANTHROPIC.test(k) || provider) out[k] = v;
  }
  out[DEPTH_ENV] = "1";
  return out;
}

const DETECT_TIMEOUT_MS = 20_000;

async function detect(repoRoot: string): Promise<Detected> {
  const bin = findOnPath("claude", [repoRoot, checkoutsDir()]);
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

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function start(opts: { snapshotDir: string; deadline: number; bin: string; web: boolean }): ReviewerSession {
  const allowed = opts.web ? [...REVIEWER_TOOLS, ...REVIEWER_WEB_TOOLS] : REVIEWER_TOOLS;
  const child = spawnGroup(opts.bin, claudeArgs(opts.web), { cwd: opts.snapshotDir, env: reviewerEnv() });
  // Every tool call is kept from the moment the agent asks for it, whether or
  // not a result follows, and whichever turn or nesting it came from.
  const pending = new Map<string, ToolCall>();
  let calls: ToolCall[] = [];
  let usage: ReviewerUsage = { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null };
  let sessionId: string | null = null;
  let failure: string | null = null;
  let waiting: ((t: Turn) => void) | null = null;
  let exited = false;

  const finish = (finalText: string, why: string | null): void => {
    const done = waiting;
    waiting = null;
    const turn: Turn = { finalText, calls, usage, sessionId, failure: why };
    calls = [];
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
      const extra = tools.filter((t) => !allowed.includes(t));
      const mcp = Array.isArray(e.mcp_servers) ? e.mcp_servers.length : 0;
      if (extra.length > 0) fail(`the reviewer started with tools it must not have: ${extra.join(", ")}`);
      else if (mcp > 0) fail("the reviewer started with MCP servers");
      else if (e.memory_paths !== undefined && e.memory_paths !== null) fail("the reviewer started with memory turned on");
      return;
    }
    const content = ((e.message as { content?: unknown } | undefined)?.content ?? []) as Record<string, unknown>[];
    if (e.type === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_use") continue;
        const call: ToolCall = { tool: String(c.name), input: c.input, ok: true, read: null };
        calls.push(call);
        if (typeof c.id === "string") pending.set(c.id, call);
      }
      return;
    }
    if (e.type === "user" && Array.isArray(content)) {
      for (const c of content) {
        if (c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
        const call = pending.get(c.tool_use_id);
        if (!call) continue;
        call.ok = c.is_error !== true;
        const file = ((e.tool_use_result as Record<string, unknown> | undefined)?.file ?? null) as Record<string, unknown> | null;
        const path = str(file?.filePath);
        const start = num(file?.startLine);
        const lines = num(file?.numLines);
        if (call.ok && call.tool === "Read" && path !== null && start !== null && lines !== null) call.read = { path, start, lines };
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
      if (e.is_error === true) fail(`the reviewer stopped with an error (${str(e.subtype) ?? "unknown"})`);
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
  // Read and dropped: it may hold the agent's view of the code.
  child.stderr?.resume();
  child.on("error", (e) => fail(`could not start the reviewer: ${e.message}`));
  child.on("exit", (code, signal) => {
    exited = true;
    clearTimeout(timer);
    if (waiting) fail(`the reviewer exited (${signal ?? `exit ${code}`}) before it answered`);
  });
  child.stdin?.on("error", () => {
    // the process is gone; its exit reports why
  });

  return {
    pid: child.pid ?? null,
    send(text: string): Promise<Turn> {
      if (failure !== null || exited) return Promise.resolve({ finalText: "", calls: [], usage, sessionId, failure: failure ?? "the reviewer is no longer running" });
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
