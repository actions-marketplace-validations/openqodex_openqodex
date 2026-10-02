// The stable command every agent hook calls. `init` copies the installed
// package to <home>/runtime/<version>/ and writes <home>/bin/openqodex, a
// POSIX sh script that runs that copy with the node binary `init` ran under.
// Hooks then never depend on npx, the npm cache or PATH.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { assetPath } from "./assets.js";
import { writeAtomic } from "./agents/files.js";

const execFileAsync = promisify(execFile);

export const LAUNCHER_MARKER = "# openqodex launcher, written by openqodex init";

// $OPENQODEX_HOME or ~/.openqodex.
export function openqodexHomeDir(): string {
  const fromEnv = process.env.OPENQODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? fromEnv : join(homedir(), ".openqodex");
}

export function launcherPath(home: string = openqodexHomeDir()): string {
  return join(home, "bin", "openqodex");
}

export function runtimeDir(version: string, home: string = openqodexHomeDir()): string {
  return join(home, "runtime", version);
}

// Single quotes for a POSIX shell; an inner single quote becomes '\''.
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launcherScript(nodePath: string, binJs: string): string {
  return [
    "#!/bin/sh",
    LAUNCHER_MARKER,
    `node=${shQuote(nodePath)}`,
    '[ -x "$node" ] || node=node',
    `exec "$node" ${shQuote(binJs)} "$@"`,
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
export function packageDir(): string {
  return assetPath();
}

export function runtimeIsCurrent(version: string, home: string): boolean {
  return sameTree(packageDir(), runtimeDir(version, home));
}

async function checkRuns(binJs: string, version: string): Promise<void> {
  const { stdout } = await execFileAsync(process.execPath, [binJs, "--version"], { timeout: 30_000 });
  if (stdout.trim() !== version) throw new Error(`the runtime copy printed "${stdout.trim()}" for --version, expected ${version}`);
}

// Copies the package to a temp folder beside the target, checks it runs,
// then swaps it in, so a failed copy never replaces a working runtime.
export async function installRuntime(version: string, home: string): Promise<void> {
  const target = runtimeDir(version, home);
  const tmp = `${target}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    cpSync(packageDir(), tmp, {
      recursive: true,
      filter: (src) => !SKIP.has(src.split(/[\\/]/).pop() ?? ""),
    });
    await checkRuns(join(tmp, "dist", "bin.js"), version);
    const old = `${target}.old-${process.pid}`;
    if (existsSync(target)) renameSync(target, old);
    renameSync(tmp, target);
    rmSync(old, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function writeLauncher(version: string, home: string): void {
  writeAtomic(launcherPath(home), launcherScript(process.execPath, join(runtimeDir(version, home), "dist", "bin.js")), 0o755);
}

export function launcherIsCurrent(version: string, home: string): boolean {
  const path = launcherPath(home);
  try {
    const expected = launcherScript(process.execPath, join(runtimeDir(version, home), "dist", "bin.js"));
    return readFileSync(path, "utf8") === expected && (statSync(path).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function launcherIsOurs(home: string): boolean {
  try {
    return readFileSync(launcherPath(home), "utf8").split("\n")[1] === LAUNCHER_MARKER;
  } catch {
    return false;
  }
}
