// The stable command every hook and the user-scope skill call. `init` and
// `hook install` copy the installed package to <home>/runtime/<version>/,
// write <home>/runtime/current (the active version, one line) and write
// <home>/bin/openqodex, a POSIX sh script that runs the runtime `current`
// names with the node binary they ran under, or the version baked into it
// when `current` is missing, malformed or names a runtime that is gone.
// Hooks then never depend on npx, the npm cache or PATH, and switching
// versions is one atomic write of `current`.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { openqodexHome } from "@openqodex/scanners";
import { assetPath } from "./assets.js";
import { readText, sha256, writeAtomic } from "./agents/files.js";
import { takeLock } from "./agents/lock.js";
import { ownedFile, type Action } from "./agents/plan.js";
import type { InstallRecord } from "./agents/record.js";
import { readState, userConfigPath } from "./update/state.js";

const execFileAsync = promisify(execFile);

export const LAUNCHER_MARKER = "# openqodex launcher, written by openqodex init";

// $OPENQODEX_HOME or ~/.openqodex.
export function openqodexHomeDir(): string {
  return openqodexHome();
}

export function launcherPath(home: string): string {
  return join(home, "bin", "openqodex");
}

export function runtimeDir(version: string, home: string): string {
  return join(home, "runtime", version);
}

export function runtimeBin(home: string, version: string): string {
  return join(runtimeDir(version, home), "dist", "bin.js");
}

export function currentPath(home: string): string {
  return join(home, "runtime", "current");
}

// What the launcher accepts in `current`: a digit first (so never "." or
// ".."), then only [0-9A-Za-z.+-]. launcherScript applies the same rule in sh.
const VERSION_TEXT = /^[0-9][0-9A-Za-z.+-]*$/;

// The version `current` names, or null when it is missing or not a version.
export function readCurrent(home: string): string | null {
  let text: string;
  try {
    text = readFileSync(currentPath(home), "utf8");
  } catch {
    return null;
  }
  const line = text.split("\n")[0] ?? "";
  return VERSION_TEXT.test(line) ? line : null;
}

// Points the launcher at `version`: a temp file then a rename, so the
// launcher never reads half a line.
export function writeCurrent(home: string, version: string): void {
  if (!VERSION_TEXT.test(version)) throw new Error(`not a version: ${version}`);
  const path = currentPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${version}\n`, { flag: "wx", mode: 0o644 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Single quotes for a POSIX shell; an inner single quote becomes '\''.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, () => `'\\''`)}'`;
}

// The launcher as the skill, the agent hooks and the Claude Code permission
// rules write it: bare when the path needs no shell quoting, so a rule such
// as `Bash(/home/me/.openqodex/bin/openqodex review *)` matches the command
// text the agent runs character for character; quoted otherwise.
export function launcherRunner(path: string): string {
  return /^[A-Za-z0-9_./@+-]+$/.test(path) ? path : shQuote(path);
}

// `hook check` must never fail a push by accident, so for that command the
// script exits 0 whatever happens (no node, a broken runtime, an old node),
// with one line on stderr saying how to repair it. Every other command gets
// exit 2 when it cannot start, which the git hook does not treat as a finding.
//
// `current` is read with the shell's own `read`, never run or expanded. A
// line that breaks the version rule, or names a runtime with no
// dist/bin.js, leaves the baked-in runtime in place.
export function launcherScript(nodePath: string, home: string, version: string): string {
  const repair = "run npx openqodex init again to repair it";
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `node=${shQuote(nodePath)}`,
    `runtimes=${shQuote(join(home, "runtime"))}`,
    `bin=${shQuote(runtimeBin(home, version))}`,
    'current=""',
    '[ -f "$runtimes/current" ] && IFS= read -r current < "$runtimes/current"',
    'case "$current" in',
    '  [0-9]*) case "$current" in *[!0-9A-Za-z.+-]*) ;; *) [ -f "$runtimes/$current/dist/bin.js" ] && bin="$runtimes/$current/dist/bin.js" ;; esac ;;',
    "esac",
    '[ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=""',
    // The runtime knows it was started here, and from which file: only
    // then does it check for updates (see launcherStarted).
    'OPENQODEX_LAUNCHER="$bin"',
    "export OPENQODEX_LAUNCHER",
    'if [ "$1" = hook ] && [ "$2" = check ]; then',
    `  if [ -z "$node" ] || [ ! -f "$bin" ]; then echo "openqodex: the push check could not start (no node or no runtime); ${repair}" >&2; exit 0; fi`,
    `  "$node" "$bin" "$@" || echo "openqodex: the push check failed to run; ${repair}" >&2`,
    "  exit 0",
    "fi",
    `if [ -z "$node" ] || [ ! -f "$bin" ]; then echo "openqodex: cannot start (no node or no runtime); ${repair}" >&2; exit 2; fi`,
    'exec "$node" "$bin" "$@"',
    "",
  ].join("\n");
}

// True when this process was started by the launcher: the launcher exports
// the runtime file it ran, and that is this process's own entry file. A child
// that inherits the variable but runs another file (npx, a project-scope
// pin) does not count.
export function launcherStarted(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): boolean {
  const named = env.OPENQODEX_LAUNCHER;
  return named !== undefined && named !== "" && entry !== undefined && resolve(named) === resolve(entry);
}

// The version baked into the launcher script, from its bin= line; null when
// the launcher is missing or not ours.
export function bakedVersion(home: string): string | null {
  const text = readText(launcherPath(home));
  if (text === null || !text.includes(LAUNCHER_MARKER)) return null;
  const m = /^bin='(.*)'$/m.exec(text);
  const parts = m ? m[1]!.split("/") : [];
  // .../runtime/<version>/dist/bin.js
  const v = parts[parts.length - 3];
  return v !== undefined && VERSION_TEXT.test(v) ? v : null;
}

const SKIP = new Set(["node_modules"]);

// Relative path to sha256 for every file under `root`, skipping node_modules.
function treeHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.set(relative(root, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  walk(root);
  return out;
}

export function sameTree(a: string, b: string): boolean {
  if (!existsSync(b)) return false;
  const ha = treeHashes(a);
  const hb = treeHashes(b);
  if (ha.size !== hb.size) return false;
  for (const [k, v] of ha) if (hb.get(k) !== v) return false;
  return true;
}

// The installed package folder: the one that holds dist/.
function packageDir(): string {
  return assetPath();
}

export async function checkRuns(binJs: string, version: string): Promise<void> {
  const { stdout } = await execFileAsync(process.execPath, [binJs, "--version"], { timeout: 30_000 });
  if (stdout.trim() !== version) throw new Error(`the runtime copy printed "${stdout.trim()}" for --version, expected ${version}`);
}

// Copies the package to a temp folder beside the target, checks it runs,
// then swaps it in, so a failed copy never replaces a working runtime.
async function installRuntime(version: string, home: string): Promise<void> {
  const target = runtimeDir(version, home);
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(packageDir(), tmp, { recursive: true, filter: (src) => !SKIP.has(src.split(/[\\/]/).pop() ?? "") });
    await checkRuns(join(tmp, "dist", "bin.js"), version);
    const old = `${target}.old-${process.pid}`;
    if (existsSync(target)) renameSync(target, old);
    renameSync(tmp, target);
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The runtime copy, the pointer to it and the launcher, as plan actions. A
// runtime folder or a launcher that is there and not recorded as ours is
// refused, never replaced.
export function planRuntime(record: InstallRecord, version: string, home: string): Action[] {
  const rt = runtimeDir(version, home);
  const launcher = launcherPath(home);
  const actions: Action[] = [];
  const recorded = record.runtimes.includes(rt);
  if (sameTree(packageDir(), rt)) {
    if (!recorded) record.runtimes.push(rt);
    actions.push({ verb: "skip", path: rt, note: "runtime already present" });
  } else if (existsSync(rt) && !recorded) {
    actions.push({ verb: "refuse", failed: true, path: rt, note: "a folder openqodex init did not write is in the way; move it aside" });
  } else {
    actions.push({
      verb: existsSync(rt) ? "update" : "create",
      path: rt,
      note: "a copy of this openqodex that the hooks and the skill run",
      apply: async () => {
        await installRuntime(version, home);
        if (!record.runtimes.includes(rt)) record.runtimes.push(rt);
      },
    });
  }

  const pointer = currentPath(home);
  if (readCurrent(home) === version && record.pointers.includes(pointer)) {
    actions.push({ verb: "skip", path: pointer, note: `the launcher already runs ${version}` });
  } else {
    actions.push({
      verb: existsSync(pointer) ? "update" : "create",
      path: pointer,
      note: `points the launcher at ${version}`,
      apply: () => {
        writeCurrent(home, version);
        if (!record.pointers.includes(pointer)) record.pointers.push(pointer);
      },
    });
  }

  const script = launcherScript(process.execPath, home, version);
  const before = readText(launcher);
  const remember = (): void => {
    record.files = record.files.filter((f) => f.path !== launcher);
    record.files.push({ path: launcher, sha256: createHash("sha256").update(script).digest("hex"), usesLauncher: false });
  };
  const write = (): void => {
    writeAtomic(launcher, script, 0o755);
    remember();
  };
  if (before === script) {
    // Exactly what we would write, down to the paths: ours.
    if (!ownedFile(record, launcher, before)) remember();
    actions.push({ verb: "skip", path: launcher, note: "launcher already present" });
  } else if (before === null || ownedFile(record, launcher, before)) {
    actions.push({ verb: before === null ? "create" : "update", path: launcher, note: "launcher the hooks and the skill call", guard: { path: launcher, before }, apply: write });
  } else {
    actions.push({ verb: "refuse", failed: true, path: launcher, note: "a launcher openqodex init did not write is in the way; move it aside" });
  }
  return actions;
}

// What still calls the launcher once this run is done: recorded agent hooks
// (including one in a file that could not be parsed) and recorded git hooks
// that are still on disk as we wrote them.
export function launcherUsers(record: InstallRecord): string[] {
  const hooks = record.hooks.filter((h) => h.usesLauncher).map((h) => h.path);
  const gitHooks = record.files.filter((f) => f.usesLauncher && ownedFile(record, f.path, readText(f.path))).map((f) => f.path);
  return [...new Set([...hooks, ...gitHooks])];
}

// Removes the recorded runtimes and launcher once nothing recorded calls them.
export function planRuntimeRemoval(record: InstallRecord, home: string, willStay: string[]): Action[] {
  const launcher = launcherPath(home);
  if (willStay.length > 0) {
    return [{ verb: "keep", path: launcher, note: `launcher and runtime kept: still called by ${willStay.join(", ")}` }];
  }
  const actions: Action[] = [];
  for (const rt of record.runtimes) {
    actions.push({
      verb: "remove",
      path: rt,
      note: "runtime copy of openqodex",
      apply: () => {
        if (launcherUsers(record).length > 0) throw new Error(`kept: still called by ${launcherUsers(record).join(", ")}`);
        rmSync(rt, { recursive: true, force: true });
        try {
          rmdirSync(dirname(rt));
        } catch {
          // other files are there; they are not ours
        }
        record.runtimes = record.runtimes.filter((r) => r !== rt);
      },
    });
  }
  for (const pointer of record.pointers) {
    actions.push({
      verb: "remove",
      path: pointer,
      note: "the launcher's pointer to the active runtime",
      apply: () => {
        if (launcherUsers(record).length > 0) throw new Error(`kept: still called by ${launcherUsers(record).join(", ")}`);
        rmSync(pointer, { force: true });
        try {
          rmdirSync(dirname(pointer));
        } catch {
          // other files are there
        }
        record.pointers = record.pointers.filter((p) => p !== pointer);
      },
    });
  }
  const text = readText(launcher);
  if (ownedFile(record, launcher, text)) {
    actions.push({
      verb: "remove",
      path: launcher,
      note: "launcher",
      guard: { path: launcher, before: text },
      apply: () => {
        if (launcherUsers(record).length > 0) throw new Error(`kept: still called by ${launcherUsers(record).join(", ")}`);
        rmSync(launcher, { force: true });
        try {
          rmdirSync(dirname(launcher));
        } catch {
          // not empty
        }
        record.files = record.files.filter((f) => f.path !== launcher);
      },
    });
  } else if (record.files.some((f) => f.path === launcher)) {
    record.files = record.files.filter((f) => f.path !== launcher);
  }
  actions.push(...planUpdateFilesRemoval(home));
  return actions;
}

// The update check's files go with the launcher: its state and locks, and
// the user config.yaml only when `update` created it and it is unchanged.
function planUpdateFilesRemoval(home: string): Action[] {
  const actions: Action[] = [];
  const config = userConfigPath(home);
  const configText = readText(config);
  const state = readState(home);
  if (configText !== null && state.userConfig !== null && state.userConfig === sha256(configText)) {
    actions.push({ verb: "remove", path: config, note: "the update switch openqodex update wrote", guard: { path: config, before: configText }, apply: () => rmSync(config, { force: true }) });
  }
  for (const name of ["update.json", "update.json.lock", "update.lock"]) {
    const path = join(home, name);
    if (!existsSync(path)) continue;
    actions.push({
      verb: "remove",
      path,
      note: name === "update.json" ? "the update check's state" : "a lock of the update check",
      apply: () => {
        // A live worker keeps its lock; it ends within ten minutes.
        if (name !== "update.json" && takeLock(path) === null && existsSync(path)) return;
        rmSync(path, { force: true });
      },
    });
  }
  return actions;
}
