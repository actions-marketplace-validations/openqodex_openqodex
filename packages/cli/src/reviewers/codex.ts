// Codex as the reviewer: one `codex exec` run per answer, in the snapshot
// folder, the prompt on standard input, the --json event stream on standard
// output. Every part of the command line below was shown to do what its
// comment says with codex-cli 0.160.0; docs/internal-reviewer-drivers.md
// records the runs.
//
// Two limits hold with Codex and are stated in the docs: the developer's
// global ~/.codex/AGENTS.md reaches the model (no switch leaves it out), and
// the event stream does not show every command the model runs. So the
// driver says `traced: false`: the commands it reports are a diagnostic list,
// never a record of what was read. The boundary is Codex's own permission
// profile, which kept reads inside the snapshot in every test.
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { ReviewerUsage } from "@openqodex/core";
import { checkoutsDir } from "../checkout.js";
import { DEPTH_ENV, findOnPath, killGroup, spawnGroup } from "./driver.js";
import type { Detected, ReviewerDriver, ReviewerSession, Turn } from "./driver.js";
import type { ToolCall } from "./trace.js";

const execFileAsync = promisify(execFile);

// The oldest version the command line was tested with. An older Codex may
// not know a flag below, or may read one differently, so it is refused.
export const CODEX_TESTED = "0.160.0";

// The flags that turn Codex features off: plugins, apps, hooks, subagents,
// memories, browser and computer use, images, skill search and the rest.
const DISABLED = ["plugins", "apps", "hooks", "multi_agent", "memories", "browser_use", "computer_use", "image_generation", "skill_search", "tool_suggest", "goals", "in_app_browser", "view_image"];

// `web`: Codex's web search tool is on only when the user config sets
// `reviewer_web: on`. Shell commands get no network either way: the
// permission profile has no network entry.
export function codexArgs(snapshotDir: string, web: boolean): string[] {
  return [
    "exec",
    // One JSON event per line; the run ends after one answer.
    "--json",
    "--color",
    "never",
    // No rollout file is written. A correction round is a new run that
    // carries the conversation so far.
    "--ephemeral",
    "--skip-git-repo-check",
    // The developer's config.toml (MCP servers, plugins, model, trusted
    // projects) and rules files are not read.
    "--ignore-user-config",
    "--ignore-rules",
    "-C",
    snapshotDir,
    "-c",
    'approval_policy="never"',
    // Reads confined to the snapshot and the system folders a command needs
    // to start; writes and network refused; /tmp denied.
    "-c",
    'default_permissions="openqodex_review"',
    "-c",
    'permissions.openqodex_review.filesystem={":minimal"="read",":project_roots"="read","/tmp"="deny"}',
    "-c",
    // "cached" answers from OpenAI's search index and opens no address the
    // model names.
    `web_search="${web ? "cached" : "disabled"}"`,
    // No AGENTS.md from the snapshot.
    "-c",
    "project_doc_max_bytes=0",
    "-c",
    "allow_login_shell=false",
    "-c",
    'shell_environment_policy.inherit="core"',
    // No skill from the snapshot is listed to the model.
    "-c",
    "skills.include_instructions=false",
    "-c",
    "skills.bundled.enabled=false",
    ...DISABLED.flatMap((f) => ["--disable", f]),
    "-",
  ];
}

// The reviewer's environment, from an allowlist: what Codex needs to run and
// to find its login (CODEX_HOME, or HOME for ~/.codex) and nothing else, so
// no token of the developer's (GITHUB_TOKEN, NPM_TOKEN, cloud keys, an
// OPENAI_API_KEY meant for other tools) reaches the agent. Nothing ties it to
// a running Codex session (CODEX_THREAD_ID, CODEX_SANDBOX).
const ALWAYS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "TZ", "CODEX_HOME", "CODEX_CA_CERTIFICATE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE"];

export function codexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && (ALWAYS.includes(k) || k.startsWith("LC_"))) out[k] = v;
  }
  out[DEPTH_ENV] = "1";
  return out;
}

// True when `version` is older than CODEX_TESTED.
export function olderThanTested(version: string): boolean {
  const a = version.split(".").map((n) => Number.parseInt(n, 10));
  const b = CODEX_TESTED.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? (a[i] as number) : 0;
    const y = b[i] as number;
    if (x !== y) return x < y;
  }
  return false;
}

const DETECT_TIMEOUT_MS = 20_000;

async function detect(repoRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<Detected> {
  // Inside a Codex sandbox (a Codex session ran `openqodex review`), a
  // nested `codex exec` stops at once: "failed to initialize in-process
  // app-server client: Operation not permitted", with or without network.
  if (env.CODEX_SANDBOX) {
    return { ok: false, missing: "Codex cannot start a second Codex inside its own sandbox", fix: "review with the agent you are in (below), or run openqodex review outside the sandbox" };
  }
  const bin = findOnPath("codex", [repoRoot, checkoutsDir()], env.PATH ?? "");
  if (bin === null) return { ok: false, missing: "Codex (codex) is not on PATH", fix: "install Codex and log in, then review again" };
  const childEnv = codexEnv(env);
  let version: string;
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { env: childEnv, timeout: DETECT_TIMEOUT_MS });
    version = /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? stdout.trim();
  } catch (error) {
    return { ok: false, missing: `codex --version failed: ${String((error as Error).message).split("\n")[0]}`, fix: "reinstall Codex" };
  }
  if (olderThanTested(version)) return { ok: false, missing: `Codex ${version} is older than ${CODEX_TESTED}, the oldest version tested as a reviewer`, fix: "update Codex, then review again" };
  // Exit 0 and "Logged in using ChatGPT" (or an API key) when logged in;
  // exit 1 and "Not logged in" when not.
  try {
    await execFileAsync(bin, ["login", "status"], { env: childEnv, timeout: DETECT_TIMEOUT_MS });
  } catch {
    return { ok: false, missing: `Codex ${version} is not logged in`, fix: "run codex login, then review again" };
  }
  return { ok: true, version, bin };
}

// Bounds on what the stream reader holds, checked as the bytes arrive: one
// event line (a command's output rides in its event), the commands of one
// answer, and the answer itself, the same limit the run applies.
const MAX_EVENT_LINE_CHARS = 16 * 1024 * 1024;
const MAX_TRACE_CHARS = 8 * 1024 * 1024;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;

type Event = Record<string, unknown> & { type?: string };

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// What one `codex exec` run gave: its answer only after a `turn.completed`
// event and exit 0; else a failure in one line.
export type CodexRun = { finalText: string; calls: ToolCall[]; input: number | null; output: number | null; failure: string | null };

// Reads one run's event lines, as they arrive. `line` returns a failure as
// soon as a bound is passed, so the caller can stop the process.
export function codexStream(): { line(text: string): string | null; end(code: number | null, signal: string | null): CodexRun } {
  let answer: string | null = null;
  let completed = false;
  let failed: string | null = null;
  let input: number | null = null;
  let output: number | null = null;
  let traceChars = 0;
  const calls: ToolCall[] = [];
  const onEvent = (e: Event): string | null => {
    if (e.type === "turn.completed") {
      completed = true;
      const u = (e.usage ?? {}) as Record<string, unknown>;
      input = num(u.input_tokens);
      output = num(u.output_tokens);
      return null;
    }
    if (e.type === "turn.failed" || e.type === "error") {
      const message = str((e.error as Record<string, unknown> | undefined)?.message) ?? str(e.message) ?? "unknown";
      failed ??= `the reviewer stopped with an error (${message.split("\n")[0]?.slice(0, 200)})`;
      return null;
    }
    if (e.type !== "item.completed") return null;
    const item = (e.item ?? {}) as Record<string, unknown>;
    if (item.type === "agent_message") {
      const text = typeof item.text === "string" ? item.text : "";
      if (Buffer.byteLength(text, "utf8") > MAX_ANSWER_BYTES) return `the reviewer stopped: its answer over ${MAX_ANSWER_BYTES / 1024 / 1024} MB`;
      answer = text;
      return null;
    }
    // Only the commands the stream shows; the rest are not seen.
    let call: ToolCall | null = null;
    if (item.type === "command_execution") call = { tool: "shell", input: { command: String(item.command ?? "") }, ok: item.exit_code === 0, read: null };
    else if (item.type === "web_search") call = { tool: "web_search", input: { query: String(item.query ?? "") }, ok: true, read: null };
    else if (typeof item.type === "string" && item.type !== "reasoning" && item.type !== "todo_list") call = { tool: item.type, input: {}, ok: item.status !== "failed", read: null };
    if (call !== null) {
      traceChars += JSON.stringify(call.input).length;
      if (traceChars > MAX_TRACE_CHARS) return `the reviewer stopped: its trace over ${MAX_TRACE_CHARS / 1024 / 1024} MB of tool input in one answer`;
      calls.push(call);
    }
    return null;
  };
  return {
    line(text: string): string | null {
      if (text.length > MAX_EVENT_LINE_CHARS) return `the reviewer stopped: an event line over ${MAX_EVENT_LINE_CHARS / 1024 / 1024} MB`;
      let e: Event;
      try {
        e = JSON.parse(text) as Event;
      } catch {
        return null;
      }
      return onEvent(e);
    },
    end(code: number | null, signal: string | null): CodexRun {
      const base = { calls, input, output };
      if (failed !== null) return { ...base, finalText: "", failure: failed };
      if (code !== 0) return { ...base, finalText: "", failure: `the reviewer exited (${signal ?? `exit ${code}`}) before it answered` };
      if (!completed) return { ...base, finalText: "", failure: "the reviewer ended without finishing its turn" };
      if (answer === null) return { ...base, finalText: "", failure: "the reviewer finished its turn with no answer" };
      return { ...base, finalText: answer, failure: null };
    },
  };
}

// The whole conversation so far, for a run that keeps no session: the brief,
// then each earlier answer and the message that answered it, in order.
export function replay(history: string[]): string {
  if (history.length === 1) return history[0] ?? "";
  const out = [history[0] ?? ""];
  for (let i = 1; i < history.length; i++) {
    out.push(i % 2 === 1 ? "## Your answer so far" : "## openqodex replied to that answer", "", history[i] ?? "", "");
  }
  return out.join("\n\n").trimEnd();
}

function start(opts: { snapshotDir: string; deadline: number; bin: string; web: boolean }): ReviewerSession {
  // The brief, then each answer and each correction, in the order they came.
  const history: string[] = [];
  let usage: ReviewerUsage = { turns: 0, input_tokens: null, output_tokens: null, cost_usd: null };
  let child: ChildProcess | null = null;
  let closed = false;

  const run = (prompt: string): Promise<CodexRun> =>
    new Promise((done) => {
      const stream = codexStream();
      const proc = spawnGroup(opts.bin, codexArgs(opts.snapshotDir, opts.web), { cwd: opts.snapshotDir, env: codexEnv() });
      child = proc;
      let stopped: string | null = null;
      let errLine: string | null = null;
      const stop = (why: string): void => {
        stopped ??= why;
        killGroup(proc);
      };
      const timer = setTimeout(() => stop("the reviewer timed out at the deadline and was stopped"), Math.max(0, opts.deadline - Date.now()));
      timer.unref();
      let buf = "";
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        if (stopped !== null) return;
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl !== -1 && stopped === null; nl = buf.indexOf("\n")) {
          const why = stream.line(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (why !== null) stop(why);
        }
        if (stopped === null && buf.length > MAX_EVENT_LINE_CHARS) stop(`the reviewer stopped: an event line over ${MAX_EVENT_LINE_CHARS / 1024 / 1024} MB`);
        if (stopped !== null) buf = "";
      });
      // Read and dropped, but for an error line: the rest may hold the
      // agent's view of the code.
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        const hit = /^Error: (.{1,200})/m.exec(chunk);
        if (hit) errLine = hit[1] ?? null;
      });
      proc.on("error", (e) => stop(`could not start the reviewer: ${e.message}`));
      proc.on("close", (code, signal) => {
        clearTimeout(timer);
        // Children the agent left behind go with the group.
        killGroup(proc);
        if (child === proc) child = null;
        if (stopped === null && buf !== "") {
          const why = stream.line(buf);
          if (why !== null) stopped = why;
        }
        const r = stream.end(code, signal);
        if (stopped !== null) return done({ ...r, finalText: "", failure: stopped });
        if (r.failure !== null && errLine !== null && r.failure.includes("exited")) return done({ ...r, failure: `${r.failure}: ${errLine}` });
        done(r);
      });
      proc.stdin?.on("error", () => {
        // the process is gone; its exit reports why
      });
      proc.stdin?.end(prompt);
    });

  return {
    pid: null,
    async send(text: string): Promise<Turn> {
      if (closed) return { finalText: "", calls: [], usage, sessionId: null, failure: "the reviewer is no longer running" };
      history.push(text);
      const r = await run(replay(history));
      usage = {
        turns: usage.turns + 1,
        input_tokens: r.input === null ? usage.input_tokens : (usage.input_tokens ?? 0) + r.input,
        output_tokens: r.output === null ? usage.output_tokens : (usage.output_tokens ?? 0) + r.output,
        cost_usd: null,
      };
      if (r.failure === null) history.push(r.finalText);
      return { finalText: r.finalText, calls: r.calls, usage, sessionId: null, failure: r.failure };
    },
    kill(): void {
      closed = true;
      if (child !== null) killGroup(child);
    },
    async close(): Promise<void> {
      closed = true;
      if (child !== null) killGroup(child);
    },
  };
}

export const codexDriver: ReviewerDriver = { name: "codex", traced: false, detect: (repoRoot) => detect(repoRoot), start };
export { detect as detectCodex };
