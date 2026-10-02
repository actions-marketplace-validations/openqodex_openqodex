// The few git lookups `init` and `hook` need. Never through a shell.
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Action } from "./plan.js";
import { readText, writeAtomic } from "./files.js";

const execFileAsync = promisify(execFile);

async function gitLine(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1 << 20 });
    const line = stdout.trim();
    return line === "" ? null : line;
  } catch {
    return null;
  }
}

// The top of the work tree, or null outside a git repository.
export async function repoRootOf(cwd: string): Promise<string | null> {
  return gitLine(cwd, ["rev-parse", "--show-toplevel"]);
}

// `git rev-parse --git-path <name>` as an absolute path. Honours worktrees
// and core.hooksPath.
export async function gitPath(repoRoot: string, name: string): Promise<string> {
  const p = await gitLine(repoRoot, ["rev-parse", "--git-path", name]);
  if (p === null) throw new Error(`git rev-parse --git-path ${name} failed in ${repoRoot}`);
  return isAbsolute(p) ? p : resolve(repoRoot, p);
}

export async function trackedFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 256 << 20 });
  return stdout.split("\0").filter((p) => p !== "");
}

// The line in .git/info/exclude that hides one repo file from git status.
export function excludeLine(repoRoot: string, file: string): string {
  return `/${relative(repoRoot, file).split("\\").join("/")}`;
}

function lines(text: string | null): string[] {
  return text === null ? [] : text.split("\n");
}

export function planExclude(excludeFile: string, line: string): Action {
  const text = readText(excludeFile);
  if (lines(text).includes(line)) return { verb: "skip", path: excludeFile, note: `${line} already excluded from git` };
  const next = text === null || text === "" ? `${line}\n` : `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
  return {
    verb: text === null ? "create" : "append",
    path: excludeFile,
    note: `exclude ${line} so git status does not change`,
    apply: () => writeAtomic(excludeFile, next),
  };
}

export function planUnexclude(excludeFile: string, line: string): Action | null {
  const text = readText(excludeFile);
  if (text === null || !lines(text).includes(line)) return null;
  const next = lines(text).filter((l) => l !== line).join("\n");
  return { verb: "update", path: excludeFile, note: `remove ${line}`, apply: () => writeAtomic(excludeFile, next) };
}
