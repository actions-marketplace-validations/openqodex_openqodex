// The stable command every hook calls. `init` and `hook install` copy the
// installed package to <home>/runtime/<version>/ and write <home>/bin/openqodex,
// a POSIX sh script that runs that copy with the node binary they ran under.
// Hooks then never depend on npx, the npm cache or PATH.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { openqodexHome } from "@openqodex/scanners";
import { assetPath } from "./assets.js";
import { readText, writeAtomic } from "./agents/files.js";
import { ownedFile, type Action } from "./agents/plan.js";
import type { InstallRecord } from "./agents/record.js";

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

// Single quotes for a POSIX shell; an inner single quote becomes '\''.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, () => `'\\''`)}'`;
}

// `hook check` must never fail a push by accident, so for that command the
// script exits 0 whatever happens (no node, a broken runtime, an old node),
// with one line on stderr saying how to repair it. Every other command gets
// exit 2 when it cannot start, which the git hook does not treat as a finding.
export function launcherScript(nodePath: string, binJs: string): string {
  const repair = "run npx openqodex init again to repair it";
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `node=${shQuote(nodePath)}`,
    `bin=${shQuote(binJs)}`,
    '[ -x "$node" ] || node=$(command -v node 2>/dev/null) || node=""',
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

function sameTree(a: string, b: string): boolean {
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

async function checkRuns(binJs: string, version: string): Promise<void> {
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

// The runtime copy and the launcher, as plan actions. A runtime folder or a
// launcher that is there and not recorded as ours is refused, never replaced.
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
      note: "a copy of this openqodex that the hooks run",
      apply: async () => {
        await installRuntime(version, home);
        if (!record.runtimes.includes(rt)) record.runtimes.push(rt);
      },
    });
  }

  const script = launcherScript(process.execPath, join(rt, "dist", "bin.js"));
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
    actions.push({ verb: before === null ? "create" : "update", path: launcher, note: "launcher the hooks call", guard: { path: launcher, before }, apply: write });
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
  return actions;
}
