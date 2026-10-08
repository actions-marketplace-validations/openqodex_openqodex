// The few git lookups `init` and `hook` need. Never through a shell.
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { Action } from "./plan.js";
import { assertNotSymlink, readText } from "./files.js";
import type { Guard } from "./guarded-fs.js";
import type { InstallRecord } from "./record.js";

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

// The repository's git folders, absolute: this work tree's own and the one
// all work trees share (the same folder outside a linked work tree).
export async function gitDirs(repoRoot: string): Promise<string[]> {
  const out: string[] = [];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const p = await gitLine(repoRoot, ["rev-parse", flag]);
    if (p !== null) out.push(isAbsolute(p) ? p : resolve(repoRoot, p));
  }
  return out;
}

// True when `file` lies in the work tree and outside every git folder that
// lies inside the work tree: a path git could stage. A git folder that holds
// the work tree (a work tree at /x/repo.git/main) excludes nothing, or no
// file in that work tree would count.
export function inWorkTree(repoRoot: string, gitFolders: string[], file: string): boolean {
  const within = (dir: string, path: string) => {
    const rel = relative(dir, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const excluding = gitFolders.filter((dir) => within(repoRoot, dir) && relative(repoRoot, dir) !== "");
  return within(repoRoot, file) && !excluding.some((dir) => within(dir, file));
}

// The files of the work tree a review can see: tracked ones and untracked
// ones git does not ignore, as the change source counts them.
export async function repoFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, maxBuffer: 256 << 20 });
  return [...new Set(stdout.split("\0").filter((p) => p !== ""))];
}

// Whether git tracks this file: a team file that was committed stays on uninstall.
export async function isTracked(repoRoot: string, file: string): Promise<boolean> {
  return (await gitLine(repoRoot, ["ls-files", "--", relative(repoRoot, file)])) !== null;
}

// The line in .git/info/exclude that hides one repo file from git status.
export function excludeLine(repoRoot: string, file: string): string {
  return `/${relative(repoRoot, file).split("\\").join("/")}`;
}

function lines(text: string | null): string[] {
  return text === null ? [] : text.split("\n");
}

// Adds the line unless it is there. A line that was there before init is the
// developer's and is not recorded; a line another work tree of the same
// repository added (worktrees share the exclude file) is shared.
export function planExclude(excludeFile: string, line: string, repo: string, record: InstallRecord, guard: Guard): Action {
  assertNotSymlink(excludeFile);
  const text = readText(excludeFile);
  const recs = record.excludes.filter((e) => e.file === excludeFile && e.line === line);
  const mine = { file: excludeFile, line, repo };
  if (lines(text).includes(line)) {
    if (recs.length > 0 && !recs.some((e) => e.repo === repo)) record.excludes.push(mine);
    return { verb: "skip", path: excludeFile, note: `${line} already excluded from git` };
  }
  const next = text === null || text === "" ? `${line}\n` : `${text}${text.endsWith("\n") ? "" : "\n"}${line}\n`;
  return {
    verb: text === null ? "create" : "append",
    path: excludeFile,
    note: `exclude ${line} so git status does not change`,
    guard: { path: excludeFile, before: text },
    apply: () => {
      guard.write(excludeFile, next, { keepMode: true });
      record.excludes = record.excludes.filter((e) => !(e.file === excludeFile && e.line === line && e.repo === repo));
      record.excludes.push(mine);
    },
  };
}

// Removes the line only when we added it and no other recorded work tree
// still needs it.
export function planUnexclude(excludeFile: string, line: string, repo: string, record: InstallRecord, guard: Guard): Action | null {
  const recs = record.excludes.filter((e) => e.file === excludeFile && e.line === line);
  if (!recs.some((e) => e.repo === repo)) return null;
  const forget = (): void => {
    record.excludes = record.excludes.filter((e) => !(e.file === excludeFile && e.line === line && e.repo === repo));
  };
  const others = recs.filter((e) => e.repo !== repo);
  if (others.length > 0) {
    forget();
    return { verb: "keep", path: excludeFile, note: `${line} is still needed by ${others[0].repo}` };
  }
  assertNotSymlink(excludeFile);
  const text = readText(excludeFile);
  const all = lines(text);
  const at = all.lastIndexOf(line);
  if (text === null || at === -1) {
    forget();
    return null;
  }
  const next = [...all.slice(0, at), ...all.slice(at + 1)].join("\n");
  return {
    verb: "update",
    path: excludeFile,
    note: `remove ${line}`,
    guard: { path: excludeFile, before: text },
    apply: () => {
      guard.write(excludeFile, next, { keepMode: true });
      forget();
    },
  };
}
