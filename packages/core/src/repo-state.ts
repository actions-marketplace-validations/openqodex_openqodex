// The only functions that touch the repo's own state: every path under
// `.openqodex/` and the root `.openqodex.yaml`. Whoever wrote the commit or
// the work tree controls those paths, so no component below the repo root
// may be a symbolic link, and no read blocks or runs without a bound.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { OpenQodexError } from "./types.js";

// The cap for run files (receipts, manifests, reports). Callers with their
// own limit (the config, the instructions) pass it.
export const RUN_FILE_MAX_BYTES = 8 * 1024 * 1024;

function steps(repoRoot: string, path: string): string[] {
  const rel = relative(repoRoot, resolve(repoRoot, path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new OpenQodexError(`${path} is not inside ${repoRoot}`);
  return rel.split(sep);
}

function linkError(repoRoot: string, at: string): OpenQodexError {
  return new OpenQodexError(`${relative(repoRoot, at)} is a symbolic link; openqodex reads and writes only real files and folders there`);
}

// What is at `path` (absolute, or relative to the repo root), by lstat alone:
// null when it or a folder on the way is missing. A link anywhere below the
// root throws.
export function repoStat(repoRoot: string, path: string): Stats | null {
  const parts = steps(repoRoot, path);
  let at = repoRoot;
  let st: Stats | null = null;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    st = lstatSync(at, { throwIfNoEntry: false }) ?? null;
    if (st === null) return null;
    if (st.isSymbolicLink()) throw linkError(repoRoot, at);
    if (i < parts.length - 1 && !st.isDirectory()) return null;
  }
  return st;
}

// Reads at most `maxBytes + 1` bytes from an open regular file.
function readBounded(fd: number, label: string, maxBytes: number, hint: string): string {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new OpenQodexError(`${label} is not a regular file`);
  const tooBig = (size: number): OpenQodexError =>
    new OpenQodexError(`${label} is ${Math.ceil(size / 1024)} KB, over the ${Math.floor(maxBytes / 1024)} KB limit${hint}`);
  if (st.size > maxBytes) throw tooBig(st.size);
  // The file may grow after fstat: read in chunks and stop past the cap.
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(64 * 1024);
    const n = readSync(fd, chunk, 0, chunk.length, null);
    if (n === 0) break;
    chunks.push(chunk.subarray(0, n));
    total += n;
    if (total > maxBytes) throw tooBig(total);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The text of a regular file in the repo state, or null when it is missing.
// A link on the way, a folder or device in its place, or a file over the cap
// throws one line. `hint` ends the over-the-cap message.
export function readRepoFile(repoRoot: string, path: string, maxBytes = RUN_FILE_MAX_BYTES, hint = ""): string | null {
  const st = repoStat(repoRoot, path);
  if (st === null) return null;
  const label = relative(repoRoot, resolve(repoRoot, path));
  if (!st.isFile()) throw new OpenQodexError(`${label} is not a regular file`);
  return readFileBounded(resolve(repoRoot, path), maxBytes, hint, label, true);
}

// A file outside the repo state that the developer named (`--config`): links
// are followed, but it must be a regular file within the cap.
export function readFileBounded(path: string, maxBytes: number, hint = "", label = path, noFollow = false): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow ? constants.O_NOFOLLOW : 0));
  try {
    return readBounded(fd, label, maxBytes, hint);
  } finally {
    closeSync(fd);
  }
}

// The real folder at `path` with every folder on the way made real: a link
// throws, a missing folder is created.
function realDir(repoRoot: string, parts: string[]): string {
  let at = repoRoot;
  for (const part of parts) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw linkError(repoRoot, at);
    if (st === undefined) mkdirSync(at);
    else if (!st.isDirectory()) throw new OpenQodexError(`${relative(repoRoot, at)} is not a folder`);
  }
  return at;
}

// Writes `content` to `path` in the repo state, making the folders on the way.
// A link at the file or on the way throws. A temp file then a rename, so a
// reader never sees half a file; with `exclusive` the file is created only
// when nothing is there, and false says something was.
export function writeRepoFile(repoRoot: string, path: string, content: string, opts: { exclusive?: boolean } = {}): boolean {
  const parts = steps(repoRoot, path);
  const dir = realDir(repoRoot, parts.slice(0, -1));
  const target = join(dir, parts[parts.length - 1]!);
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw linkError(repoRoot, target);
  if (opts.exclusive) {
    try {
      writeFileSync(target, content, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
  const tmp = join(dir, `.${parts[parts.length - 1]}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return true;
}

// Removes a file or an empty folder in the repo state; nothing when it is
// missing. A link at it or on the way throws, so nothing outside is touched.
export function removeRepoFile(repoRoot: string, path: string): void {
  const st = repoStat(repoRoot, path);
  if (st === null) return;
  if (st.isDirectory()) rmdirSync(resolve(repoRoot, path));
  else unlinkSync(resolve(repoRoot, path));
}

// The names in a folder of the repo state; empty when it is missing.
export function listRepoDir(repoRoot: string, path: string): string[] {
  const st = repoStat(repoRoot, path);
  return st?.isDirectory() ? readdirSync(resolve(repoRoot, path)) : [];
}
