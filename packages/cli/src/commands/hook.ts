// `openqodex hook check`: the agent push gate the Claude Code and Codex hook
// entries call before a shell command. `openqodex hook install|uninstall`:
// the optional git pre-push hook, the gate that sees every real push.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readText, sha256, writeAtomic, writeBackup } from "../agents/files.js";
import { gitPath, repoRootOf } from "../agents/git.js";
import { ownedFile, type Action } from "../agents/plan.js";
import { pushFolders } from "../agents/push-command.js";
import { loadRecord, saveRecord, serialize, withLock } from "../agents/record.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { launcherPath, openqodexHomeDir, planRuntime, shQuote } from "../launcher.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "usage: openqodex hook check [--agent <claude-code|codex>]   (called by the agent hook, reads its JSON on stdin)",
  "       openqodex hook install [--force]                      (adds a git pre-push hook to this repo)",
  "       openqodex hook uninstall",
].join("\n");

export const GIT_HOOK_MARKER = "# openqodex pre-push hook: openqodex hook uninstall removes it";

// ---------- hook check ----------

const STDIN_DEADLINE_MS = 3000;
const STDIN_CAP_BYTES = 1 << 20;

type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };

// The whole of stdin, or null when it is not closed within the deadline or
// grows past the cap. Either way the check abstains.
function readStdin(): Promise<string | null> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (value: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners("data");
      if (value === null) process.stdin.destroy();
      done(value);
    };
    const timer = setTimeout(() => finish(null), STDIN_DEADLINE_MS);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > STDIN_CAP_BYTES) finish(null);
      else chunks.push(chunk);
    });
    process.stdin.once("end", () => finish(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", () => finish(null));
  });
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

async function aliasOf(folder: string, name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", `alias.${name}`], { cwd: folder, timeout: 2000 });
    return stdout.trim() === "" ? null : stdout.trim();
  } catch {
    return null;
  }
}

async function decide(input: HookInput): Promise<void> {
  if (typeof input.tool_name === "string" && input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string") return;
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  const folders = await pushFolders(command, cwd, aliasOf);
  if (folders.length === 0) return;

  if (process.env.OPENQODEX_SKIP === "1") {
    abstainWith("OpenQodex check skipped (OPENQODEX_SKIP is set)");
    return;
  }

  // Loaded only for a push, so every other shell command stays fast.
  const core = await import("@openqodex/core");
  const roots: string[] = [];
  for (const folder of folders) {
    try {
      const root = await core.findRepoRoot(folder);
      if (!roots.includes(root)) roots.push(root);
    } catch {
      // not a repository: git itself will say so
    }
  }
  const denials: string[] = [];
  const notes: string[] = [];
  for (const repoRoot of roots) {
    const { config } = core.loadConfig(repoRoot);
    const change = await core.getChange({ repoRoot, scope: {}, exclude: config.exclude });
    const latest = core.readLatest(repoRoot);
    const report = latest ? core.readReport(join(repoRoot, latest.dir)) : null;
    const decision = core.checkPush({ currentChangeId: change.id, latest, report, config });
    const message = decision.message === null ? null : roots.length > 1 ? `${repoRoot}: ${decision.message}` : decision.message;
    if (decision.decision === "deny") denials.push(message ?? `${repoRoot}: OpenQodex blocks this push`);
    else if (message) notes.push(message);
  }
  if (denials.length > 0) deny([...denials, ...notes].join("\n"));
  else if (notes.length > 0) abstainWith(notes.join("\n"));
}

async function check(): Promise<number> {
  try {
    const raw = await readStdin();
    if (raw === null) return EXIT_OK;
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

// Only exit 1 (a finding at or above block_on_severity) stops the push; a
// scan or a launcher that cannot run exits 2 or 127, which never does.
export function gitHookScript(launcher: string): string {
  return ["#!/bin/sh", GIT_HOOK_MARKER, `${shQuote(launcher)} scan`, "status=$?", '[ "$status" -eq 1 ] && exit 1', "exit 0", ""].join("\n");
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

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return EXIT_TOOL_FAILED;
}

async function applyAll(actions: Action[]): Promise<void> {
  for (const a of actions) {
    if (!a.apply) continue;
    if (a.guard && readText(a.guard.path) !== a.guard.before) throw new Error(`changed while openqodex was running, nothing written to ${a.guard.path}`);
    await a.apply();
  }
}

async function install(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const unknown = args.filter((a) => a !== "--force");
  if (unknown.length > 0) return fail(`openqodex hook install: unknown argument: ${unknown[0]}\n${USAGE}`);
  const target = await hookFile();
  if (target === null) return fail("openqodex hook install: run it inside a git repository");
  const home = openqodexHomeDir();
  const launcher = launcherPath(home);
  const manager = hookManager(target.repoRoot);
  if (manager !== null) {
    process.stdout.write(
      `This repo manages its git hooks with ${manager}. Add this line to its pre-push hook:\n  npx -y openqodex@${__OPENQODEX_VERSION__} scan\nNothing was written.\n`,
    );
    return EXIT_OK;
  }

  return withLock(home, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      // The hook always calls the launcher, so exit 1 can only be the scan's verdict.
      const runtime = planRuntime(record, __OPENQODEX_VERSION__, home);
      const refused = runtime.find((a) => a.failed);
      if (refused) return fail(`openqodex hook install: ${refused.path}: ${refused.note}`);
      await applyAll(runtime);

      const script = gitHookScript(launcher);
      const current = readText(target.path);
      const remember = (): void => {
        record.files = record.files.filter((f) => f.path !== target.path);
        record.files.push({ path: target.path, sha256: sha256(script), usesLauncher: true });
      };
      if (current === script) {
        remember();
        process.stdout.write(`The OpenQodex pre-push hook is already installed: ${target.path}\n`);
        return EXIT_OK;
      }
      if (current !== null && !ownedFile(record, target.path, current)) {
        if (!force) {
          return fail(
            `openqodex hook install: ${target.path} already exists and is not ours. Add this line to it:\n  ${shQuote(launcher)} scan\nor run openqodex hook install --force to replace it (the old hook is kept beside it).`,
          );
        }
        const backup = writeBackup(target.path, current);
        record.backups.push({ path: backup, of: target.path });
        process.stdout.write(`The previous hook is saved as ${backup}\n`);
      }
      if (readText(target.path) !== current) return fail(`changed while openqodex was running, nothing written to ${target.path}`);
      writeAtomic(target.path, script, 0o755);
      chmodSync(target.path, 0o755);
      remember();
      process.stdout.write(
        `Installed the OpenQodex pre-push hook: ${target.path}\nIt scans the change before each push and stops the push only when .openqodex.yaml sets block_on_severity and it is met. Undo: openqodex hook uninstall\n`,
      );
      return EXIT_OK;
    } finally {
      saveRecord(home, record, recordBefore);
    }
  });
}

async function uninstall(args: string[]): Promise<number> {
  if (args.length > 0) return fail(`openqodex hook uninstall: unknown argument: ${args[0]}\n${USAGE}`);
  const target = await hookFile();
  if (target === null) return fail("openqodex hook uninstall: run it inside a git repository");
  const home = openqodexHomeDir();
  return withLock(home, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      const current = readText(target.path);
      const ours = current !== null && (ownedFile(record, target.path, current) || current === gitHookScript(launcherPath(home)));
      const recorded = record.files.some((f) => f.path === target.path);
      record.files = record.files.filter((f) => f.path !== target.path);
      if (!ours) {
        process.stdout.write(
          current === null
            ? "No pre-push hook is installed.\n"
            : recorded
              ? `${target.path} was edited after install; left in place.\n`
              : `${target.path} is not the OpenQodex hook; left in place.\n`,
        );
        return EXIT_OK;
      }
      rmSync(target.path, { force: true });
      // Put back the newest hook --force set aside, if it is still there.
      const backups = record.backups.filter((b) => b.of === target.path);
      const last = backups[backups.length - 1];
      if (last && readText(last.path) !== null) {
        renameSync(last.path, target.path);
        record.backups = record.backups.filter((b) => b !== last);
        process.stdout.write(`Removed the OpenQodex pre-push hook and put the previous hook back: ${target.path}\n`);
      } else process.stdout.write(`Removed the OpenQodex pre-push hook: ${target.path}\n`);
      return EXIT_OK;
    } finally {
      saveRecord(home, record, recordBefore);
    }
  });
}

export async function run(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    if (sub === "check") return await check();
    if (sub === "install") return await install(rest);
    if (sub === "uninstall") return await uninstall(rest);
  } catch (error) {
    return fail(`openqodex hook ${sub}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fail(USAGE);
}
