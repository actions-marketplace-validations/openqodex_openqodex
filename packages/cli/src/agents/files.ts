// File helpers for `init` and `hook install`: reads that tell "absent" from
// "unreadable", atomic writes that keep the file's mode and write through a
// user's dotfile symlink, private backups that never overwrite each other,
// and the symlink checks for files written inside a repository.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// The file's text, or null only when it does not exist. Any other error
// (permission denied, a folder in the way) is thrown with its reason.
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(`cannot read ${path} (${errorCode(error) ?? (error as Error).message})`);
  }
}

// Where a write to `path` lands: the real file when `path` is a symlink (a
// dotfiles repo links ~/.claude/settings.json), so the link stays a link.
function writeTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  return path;
}

// Temp file then rename. An existing file keeps its mode; a new one gets
// `mode` (default 0644), narrowed by the umask.
export function writeAtomic(path: string, content: string, mode?: number): void {
  const target = writeTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  let keep: number | null = null;
  try {
    keep = statSync(target).mode & 0o7777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o644 });
    if (keep !== null) chmodSync(tmp, keep);
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Writes `content` to `<path>.openqodex.bak`, or `.bak.2`, `.bak.3`, ...
// when that name is taken. Created exclusively and private (0600).
export function writeBackup(path: string, content: string): string {
  for (let n = 1; ; n++) {
    const candidate = `${path}.openqodex.bak${n === 1 ? "" : `.${n}`}`;
    let fd: number;
    try {
      fd = openSync(candidate, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw error;
    }
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return candidate;
  }
}

function refuseLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symbolic link; openqodex does not write through links inside a repository`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

// Refuses a file inside the repository whose path runs through a symlink
// (the file itself or any folder between it and the repository root), so a
// repository cannot send our writes somewhere else.
export function assertNoSymlinkInRepo(repoRoot: string, path: string): void {
  const rel = relative(repoRoot, path);
  if (rel.startsWith("..")) return;
  let at = repoRoot;
  for (const part of rel.split(sep)) {
    at = join(at, part);
    refuseLink(at);
  }
}

// The same check for a file git names (the exclude file) and its folder.
export function assertNotSymlink(path: string): void {
  refuseLink(dirname(path));
  refuseLink(path);
}
