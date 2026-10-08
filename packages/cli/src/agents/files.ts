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
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const MAX_LINKS = 40;

// Throws when a write to `path` would follow a link that lies in the
// repository's work tree. The path is walked one component at a time, as
// the system walks it, links followed; a link whose own place is in the work
// tree (outside the git folders, which the repository cannot commit to) is
// refused. The repository decides what its work tree holds, so such a link
// could send the write anywhere. A link anywhere else is the developer's own
// (a dotfiles repo links ~/.claude/settings.json) and is followed. The rule
// comes from where a path really runs, never from the install's scope, so an
// agent folder set inside the repository (CLAUDE_CONFIG_DIR) gets it too.
// init runs it when it plans each file and again just before each write.
export function assertNoRepoLink(repoRoot: string, gitFolders: string[], path: string): void {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = real(repoRoot);
  const gitReal = gitFolders.map(real);
  const repoHeld = (p: string): boolean => within(root, p) && !gitReal.some((d) => within(d, p));
  const parts = resolve(path).split(sep).filter((x) => x !== "");
  let at: string = sep;
  let links = 0;
  while (parts.length > 0) {
    const next = join(at, parts.shift()!);
    let isLink: boolean;
    try {
      isLink = lstatSync(next).isSymbolicLink();
    } catch (error) {
      // Nothing there: nothing further on the way can be a link.
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    if (!isLink) {
      at = next;
      continue;
    }
    if (repoHeld(next)) throw new Error(`${next} is a symbolic link inside the repository; openqodex does not write through links the repository holds`);
    if (++links > MAX_LINKS) throw new Error(`more than ${MAX_LINKS} symbolic links on the way to ${path}`);
    parts.unshift(...resolve(at, readlinkSync(next)).split(sep).filter((x) => x !== ""));
    at = sep;
  }
}

// The same check for a file git names (the exclude file) and its folder.
export function assertNotSymlink(path: string): void {
  refuseLink(dirname(path));
  refuseLink(path);
}
