// `openqodex hook check`: the agent push gate the Claude Code and Codex hook
// entries call before a shell command. `openqodex hook install|uninstall`:
// the optional git pre-push hook, the gate that sees every real push. Both
// look up the review of what is pushed; neither scans nor starts a review.
import { execFile } from "node:child_process";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readText, sha256, writeAtomic, writeBackup } from "../agents/files.js";
import { gitPath, repoRootOf } from "../agents/git.js";
import { ownedFile, type Action } from "../agents/plan.js";
import { pushFolders } from "../agents/push-command.js";
import { withBoundary } from "../agents/lock.js";
import { loadRecord, saveRecord, serialize, type InstallRecord } from "../agents/record.js";
import { EXIT_OK, EXIT_TOOL_FAILED } from "../exit-codes.js";
import { readHomeReceipt } from "../receipts.js";
import { launcherPath, openqodexHomeDir, planRuntime, shQuote } from "../launcher.js";

const execFileAsync = promisify(execFile);

const USAGE = [
  "usage: openqodex hook check [--agent <claude-code|codex>]   (called by the agent hook, reads its JSON on stdin)",
  "       openqodex hook install [--force]                      (adds a git pre-push hook to this repo)",
  "       openqodex hook uninstall",
  "       openqodex hook pre-push                               (run by the git pre-push hook, reads git's lines on stdin)",
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
  const home = openqodexHomeDir();
  for (const repoRoot of roots) {
    const { config } = core.loadConfig(repoRoot);
    const change = await core.getChange({ repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase });
    // Only the record in the developer's own home counts, never one under
    // the repository's .openqodex/, which a branch can carry.
    const receipt = readHomeReceipt(home, repoRoot, change.id) ?? readHomeReceipt(home, repoRoot, "latest");
    const decision = core.checkPush({ currentChangeId: change.id, receipt, config });
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

// ---------- hook pre-push ----------

const ZERO_SHA = /^0+$/;

function readAll(): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

// The commits a push sends, from git's lines on stdin: `<local ref> <local
// sha> <remote ref> <remote sha>`. An all-zero local sha deletes the remote
// ref and sends nothing. Null for the hook run by hand with no push lines:
// the work in place is looked up.
function pushedCommits(input: string): (string | null)[] {
  const lines = input.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length === 0) return [null];
  const shas = lines.map((l) => l.split(/\s+/)[1]).filter((sha): sha is string => sha !== undefined && !ZERO_SHA.test(sha));
  return [...new Set(shas)];
}

// `openqodex hook pre-push`, run by the git pre-push hook. The same lookup
// as the agent hook (core checkPush), for exactly what is pushed: each pushed
// commit's change, measured from the base of the newest review recorded in
// the developer's home, must be a change a review there covered. It prints no scanner output and never starts a
// review. Exit 1 only when the lookup denies (block_on_severity is set and
// the review is missing or blocked); an incomplete review never blocks.
async function prePush(): Promise<number> {
  // Git sets these for hooks; they would point git at another index or tree.
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete process.env[name];
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return fail("openqodex hook pre-push: run it inside a git repository");
  const core = await import("@openqodex/core");
  const { config } = core.loadConfig(repoRoot);
  const home = openqodexHomeDir();
  // Only the record in the developer's own home counts (see hook check).
  const newest = readHomeReceipt(home, repoRoot, "latest");
  const messages = new Set<string>();
  let denied = false;
  for (const sha of pushedCommits(await readAll())) {
    let changeId: string;
    if (sha === null) {
      changeId = (await core.getChange({ repoRoot, scope: {}, exclude: config.exclude, defaultBase: config.defaultBase })).id;
    } else if (newest !== null) {
      const tree = await core.getTreeChange({ repoRoot, baseRef: newest.base.ref, baseSha: newest.base.sha, headSha: sha, exclude: config.exclude });
      changeId = tree.id;
    } else changeId = "";
    const receipt = (changeId === "" ? null : readHomeReceipt(home, repoRoot, changeId)) ?? newest;
    const decision = core.checkPush({ currentChangeId: changeId, receipt, config });
    if (decision.decision === "deny") denied = true;
    if (decision.message !== null) messages.add(decision.message);
  }
  for (const m of messages) process.stderr.write(`${m}\n`);
  return denied ? 1 : EXIT_OK;
}

// ---------- hook install / uninstall ----------

// The pre-push hook. It hands git's lines to `hook pre-push`. Only exit 1
// (block_on_severity is set and no passing review of what is pushed exists)
// stops the push; a lookup or a launcher that cannot run exits 2 or 127,
// which never does.
export function gitHookScript(launcher: string): string {
  return [
    "#!/bin/sh",
    GIT_HOOK_MARKER,
    `${shQuote(launcher)} hook pre-push "$@"`,
    "status=$?",
    '[ "$status" -eq 1 ] && exit 1',
    "exit 0",
    "",
  ].join("\n");
}

// The line to add to a pre-push hook openqodex does not write (husky,
// lefthook, a hook of the developer's own). The same exit mapping as the hook
// it writes: only exit 1 stops the push; a tool that fails (exit 2) or
// cannot start never does.
export function hookLine(command: string): string {
  return `${command} hook pre-push || [ $? -ne 1 ]`;
}

const MANAGED_LINE = (): string => hookLine(`npx -y openqodex@${__OPENQODEX_VERSION__}`);

async function hookFile(): Promise<{ repoRoot: string; path: string } | null> {
  const repoRoot = await repoRootOf(process.cwd());
  if (repoRoot === null) return null;
  return { repoRoot, path: await gitHookPath(repoRoot) };
}

export async function gitHookPath(repoRoot: string): Promise<string> {
  return join(await gitPath(repoRoot, "hooks"), "pre-push");
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

// The answer init records for its hook question; `hook install` records
// yes and `hook uninstall` forgets it, so a later init does not undo either.
export function setHookChoice(record: InstallRecord, repo: string, hook: "pre-push" | "none"): void {
  record.hookChoices = record.hookChoices.filter((c) => c.repo !== repo);
  record.hookChoices.push({ repo, hook });
}

export type GitHookPlan = {
  path: string;
  // Set when the repo runs its hooks through a hook manager: nothing is written.
  manager: string | null;
  // A pre-push hook that is not ours is there and --force was not given.
  foreign: boolean;
  action: Action;
};

// What installing the pre-push hook would do. The runtime and launcher it
// calls are planned separately (planRuntime).
export async function planGitHook(repoRoot: string, record: InstallRecord, home: string, force: boolean): Promise<GitHookPlan> {
  const path = await gitHookPath(repoRoot);
  const launcher = launcherPath(home);
  const manager = hookManager(repoRoot);
  const label = "git pre-push hook";
  if (manager !== null) {
    return {
      path,
      manager,
      foreign: false,
      action: { verb: "keep", path, note: `${label}: this repo manages its hooks with ${manager}; add ${MANAGED_LINE()} there` },
    };
  }
  const script = gitHookScript(launcher);
  const current = readText(path);
  const remember = (): void => {
    record.files = record.files.filter((f) => f.path !== path);
    record.files.push({ path, sha256: sha256(script), usesLauncher: true });
  };
  if (current === script) {
    remember();
    return { path, manager, foreign: false, action: { verb: "skip", path, note: `${label} already present` } };
  }
  const foreign = current !== null && !ownedFile(record, path, current);
  if (foreign && !force) {
    return {
      path,
      manager,
      foreign: true,
      action: { verb: "keep", path, note: `${label}: a hook openqodex did not write is there; add ${hookLine(shQuote(launcher))} to it, or run openqodex hook install --force` },
    };
  }
  return {
    path,
    manager,
    foreign: false,
    action: {
      verb: current === null ? "create" : foreign ? "replace" : "update",
      path,
      note: `${label}: a review check before every push${foreign ? ` (the old hook is saved beside it)` : ""}`,
      guard: { path, before: current },
      apply: () => {
        if (foreign) {
          const backup = writeBackup(path, current);
          record.backups.push({ path: backup, of: path });
          process.stdout.write(`The previous hook is saved as ${backup}\n`);
        }
        writeAtomic(path, script, 0o755);
        chmodSync(path, 0o755);
        remember();
      },
    },
  };
}

// What removing the pre-push hook would do; null when no hook is there.
// The newest hook --force set aside is put back.
export async function planGitHookRemoval(repoRoot: string, record: InstallRecord, home: string): Promise<Action | null> {
  const path = await gitHookPath(repoRoot);
  const current = readText(path);
  const ours = current !== null && (ownedFile(record, path, current) || current === gitHookScript(launcherPath(home)));
  const recorded = record.files.some((f) => f.path === path);
  const forget = (): void => {
    record.files = record.files.filter((f) => f.path !== path);
  };
  if (!ours) {
    forget();
    if (current === null) return null;
    return recorded ? { verb: "keep", path, note: "git pre-push hook was edited after install; left in place" } : null;
  }
  const backups = record.backups.filter((b) => b.of === path);
  const last = backups[backups.length - 1];
  const restore = last !== undefined && readText(last.path) !== null;
  return {
    verb: restore ? "restore" : "remove",
    path,
    note: restore ? "git pre-push hook removed; the previous hook is put back" : "git pre-push hook",
    guard: { path, before: current },
    apply: () => {
      rmSync(path, { force: true });
      if (restore) {
        renameSync(last.path, path);
        record.backups = record.backups.filter((b) => b !== last);
      }
      forget();
    },
  };
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
      `This repo manages its git hooks with ${manager}. Add this line to its pre-push hook:\n  ${MANAGED_LINE()}\nNothing was written.\n`,
    );
    return EXIT_OK;
  }

  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      // The hook always calls the launcher, so exit 1 can only be the scan's verdict.
      const runtime = planRuntime(record, __OPENQODEX_VERSION__, home);
      const refused = runtime.find((a) => a.failed);
      if (refused) return fail(`openqodex hook install: ${refused.path}: ${refused.note}`);
      await applyAll(runtime);
      const plan = await planGitHook(target.repoRoot, record, home, force);
      if (plan.foreign) {
        return fail(
          `openqodex hook install: ${target.path} already exists and is not ours. Add this line to it:\n  ${hookLine(shQuote(launcher))}\nor run openqodex hook install --force to replace it (the old hook is kept beside it).`,
        );
      }
      if (plan.action.verb === "skip") {
        process.stdout.write(`The OpenQodex pre-push hook is already installed: ${target.path}\n`);
        return EXIT_OK;
      }
      await applyAll([plan.action]);
      setHookChoice(record, target.repoRoot, "pre-push");
      process.stdout.write(
        `Installed the OpenQodex pre-push hook: ${target.path}\nBefore each push it checks for a review of what the push sends (openqodex review), and stops the push only when the config sets block_on_severity and that review is missing or blocked. Undo: openqodex hook uninstall\n`,
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
  return withBoundary(home, { wait: 60_000 }, async () => {
    const record = loadRecord(home);
    const recordBefore = serialize(record);
    try {
      const current = readText(target.path);
      const action = await planGitHookRemoval(target.repoRoot, record, home);
      if (action === null || action.apply === undefined) {
        process.stdout.write(
          current === null
            ? "No pre-push hook is installed.\n"
            : action !== null
              ? `${target.path} was edited after install; left in place.\n`
              : `${target.path} is not the OpenQodex hook; left in place.\n`,
        );
        return EXIT_OK;
      }
      await applyAll([action]);
      // A later init asks again.
      record.hookChoices = record.hookChoices.filter((c) => c.repo !== target.repoRoot);
      process.stdout.write(
        action.verb === "restore"
          ? `Removed the OpenQodex pre-push hook and put the previous hook back: ${target.path}\n`
          : `Removed the OpenQodex pre-push hook: ${target.path}\n`,
      );
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
    if (sub === "pre-push") return await prePush();
    if (sub === "install") return await install(rest);
    if (sub === "uninstall") return await uninstall(rest);
  } catch (error) {
    return fail(`openqodex hook ${sub}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return fail(USAGE);
}
