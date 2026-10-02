// `openqodex hook check`: the agent push gate the Claude Code and Codex hook
// entries call before a shell command. `openqodex hook install|uninstall`:
// the optional git pre-push hook.
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitPath, repoRootOf } from "../agents/git.js";
import { writeAtomic } from "../agents/files.js";
import { pushFolder } from "../agents/push-command.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherPath, openqodexHomeDir, shQuote } from "../launcher.js";

const USAGE = [
  "usage: openqodex hook check [--agent <claude-code|codex>]   (called by the agent hook, reads its JSON on stdin)",
  "       openqodex hook install [--force]                      (adds a git pre-push hook to this repo)",
  "       openqodex hook uninstall",
].join("\n");

export const GIT_HOOK_MARKER = "# openqodex pre-push hook: openqodex hook uninstall removes it";
const BACKUP = ".openqodex.bak";

// ---------- hook check ----------

type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

// One output shape for both agents: Claude Code and Codex both read
// hookSpecificOutput.permissionDecision "deny", additionalContext and
// systemMessage from a PreToolUse hook. Never "allow" or "ask".
function abstainWith(message: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message }, systemMessage: message });
}

function deny(message: string): void {
  emit({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: message } });
}

async function decide(input: HookInput): Promise<void> {
  if (typeof input.tool_name === "string" && input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const folder = pushFolder(command, cwd);
  if (folder === null) return;

  if (process.env.OPENQODEX_SKIP === "1") {
    abstainWith("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    return;
  }

  // Loaded only for a push, so every other shell command stays fast.
  const core = await import("@openqodex/core");
  const repoRoot = await core.findRepoRoot(folder);
  const { config } = core.loadConfig(repoRoot);
  const change = await core.getChange({ repoRoot, scope: {}, exclude: config.exclude });
  const latest = core.readLatest(repoRoot);
  const report = latest ? core.readReport(join(repoRoot, latest.dir)) : null;
  const decision = core.checkPush({ currentChangeId: change.id, latest, report, config });
  if (decision.decision === "deny") deny(decision.message ?? "OpenQodex blocks this push");
  else if (decision.message) abstainWith(decision.message);
}

async function check(args: string[]): Promise<number> {
  // --agent is accepted for the record; both agents read the same output.
  void args;
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw) as unknown;
    if (typeof input !== "object" || input === null) return EXIT_OK;
    await decide(input as HookInput);
  } catch (error) {
    // Never break a push by accident: say why on stderr, print nothing.
    process.stderr.write(`openqodex hook check: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  return EXIT_OK;
}

// ---------- hook install / uninstall ----------

function hookScript(version: string): string {
  const launcher = launcherPath(openqodexHomeDir());
  const runner = existsSync(launcher) ? shQuote(launcher) : `npx -y openqodex@${version}`;
  // Only exit 1 (a finding at or above block_on_severity) stops the push;
  // a scan that fails for its own reasons (exit 2) never does.
  return ["#!/bin/sh", GIT_HOOK_MARKER, `${runner} scan`, 'status=$?', '[ "$status" -eq 1 ] && exit 1', "exit 0", ""].join("\n");
}

function isOurs(text: string | null): boolean {
  return text !== null && text.split("\n").includes(GIT_HOOK_MARKER);
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function hookFile(): Promise<{ repoRoot: string; path: string } | null> {
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return null;
  return { repoRoot, path: join(await gitPath(repoRoot, "hooks"), "pre-push") };
}

function hookManager(repoRoot: string): string | null {
  if (existsSync(join(repoRoot, ".husky"))) return "husky (.husky/pre-push)";
  for (const name of ["lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml"]) {
    if (existsSync(join(repoRoot, name))) return `lefthook (${name}, under pre-push commands)`;
  }
  return null;
}

async function install(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length > 0) {
    process.stderr.write(`openqodex hook install: unknown argument: ${unknown[0]}\n${USAGE}\n`);
    return EXIT_TOOL_FAILED;
  }
  const target = await hookFile();
  if (target === null) {
    process.stderr.write("openqodex hook install: run it inside a git repository\n");
    return EXIT_TOOL_FAILED;
  }
  const version = __OPENQODEX_VERSION__;
  const line = `npx -y openqodex@${version} scan`;
  const manager = hookManager(target.repoRoot);
  if (manager !== null) {
    process.stdout.write(`This repo manages its git hooks with ${manager}. Add this line to its pre-push hook:\n  ${line}\nNothing was written.\n`);
    return EXIT_OK;
  }
  const script = hookScript(version);
  const current = readOrNull(target.path);
  if (current === script) {
    process.stdout.write(`The OpenQodex pre-push hook is already installed: ${target.path}\n`);
    return EXIT_OK;
  }
  if (current !== null && !isOurs(current)) {
    if (!force) {
      process.stderr.write(
        `openqodex hook install: ${target.path} already exists and is not ours. Add this line to it:\n  ${line}\nor run openqodex hook install --force to replace it (the old hook is kept as pre-push${BACKUP}).\n`,
      );
      return EXIT_TOOL_FAILED;
    }
    renameSync(target.path, target.path + BACKUP);
  }
  writeAtomic(target.path, script, 0o755);
  chmodSync(target.path, 0o755);
  process.stdout.write(
    `Installed the OpenQodex pre-push hook: ${target.path}\nIt scans the change before each push and stops the push only when .openqodex.yaml sets block_on_severity and it is met. Undo: openqodex hook uninstall\n`,
  );
  return EXIT_OK;
}

async function uninstall(args: string[]): Promise<number> {
  if (args.length > 0) {
    process.stderr.write(`openqodex hook uninstall: unknown argument: ${args[0]}\n${USAGE}\n`);
    return EXIT_TOOL_FAILED;
  }
  const target = await hookFile();
  if (target === null) {
    process.stderr.write("openqodex hook uninstall: run it inside a git repository\n");
    return EXIT_TOOL_FAILED;
  }
  const current = readOrNull(target.path);
  if (!isOurs(current)) {
    process.stdout.write(
      current === null ? "No pre-push hook is installed.\n" : `${target.path} is not the OpenQodex hook; left in place.\n`,
    );
    return EXIT_OK;
  }
  rmSync(target.path, { force: true });
  if (existsSync(target.path + BACKUP)) {
    renameSync(target.path + BACKUP, target.path);
    process.stdout.write(`Removed the OpenQodex pre-push hook and put the previous hook back: ${target.path}\n`);
  } else process.stdout.write(`Removed the OpenQodex pre-push hook: ${target.path}\n`);
  return EXIT_OK;
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "check") return check(rest);
  if (sub === "install") return install(rest);
  if (sub === "uninstall") return uninstall(rest);
  process.stderr.write(`${USAGE}\n`);
  return EXIT_TOOL_FAILED;
}
