// The only functions that touch the repo's own state: every path under
// `.openqodex/` and the root `.openqodex.yaml`. Whoever wrote the commit or
// the work tree controls those paths, so no component below the repo root
// may be a symbolic link, and no read blocks or runs without a bound.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { closeWider, Guard } from "./guarded-fs.js";
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
  return new OpenQodexError(
    `${relative(repoRoot, at)} is a symbolic link; openqodex reads and writes only real files and folders there: replace the link with a real file (a copy is fine)`,
  );
}

// A name as a file system may see it: letter case, Unicode normalisation,
// characters some file systems ignore (zero-width joiners and the like) and
// trailing dots or spaces do not tell two names apart.
function looseName(name: string): string {
  return name.normalize("NFC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").replace(/[. ]+$/, "").toLowerCase();
}

// True when the parts of a path from the repo root name the state.
function namesState(parts: string[]): boolean {
  const first = parts[0] === undefined ? "" : looseName(parts[0]);
  return first === ".openqodex" || (parts.length === 1 && first === ".openqodex.yaml");
}

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// When `path` names the repo state (`.openqodex` or anything under it, or the
// root `.openqodex.yaml`), its spelling from the repo root, to hand to the
// state functions; else null. Fails closed:
// - Spelling: from the shallowest folder above the path that resolves to the
//   repo root, so a link deeper in the path never stands in for the root.
// - Real location: where the path lands on disk (realpath of its deepest
//   existing part plus the rest) is the authority, so case, Unicode and
//   ignorable characters cannot hide the state. A path that lands in the
//   state across a link throws; one whose spelling names the state is handed
//   on, and the state functions refuse any link on the way.
export function isRepoState(repoRoot: string, path: string): string | null {
  const root = realOrNull(repoRoot) ?? repoRoot;
  const full = resolve(repoRoot, path);
  const chain: string[] = [];
  for (let at = full; ; at = dirname(at)) {
    chain.unshift(at);
    if (dirname(at) === at) break;
  }
  const base = chain.find((at) => realOrNull(at) === root) ?? null;
  const spelled = base === null ? null : relative(base, full);
  const spelledParts = spelled === null || spelled === "" ? [] : spelled.split(sep);

  let existing = full;
  const tail: string[] = [];
  while (realOrNull(existing) === null && dirname(existing) !== existing) {
    tail.unshift(basename(existing));
    existing = dirname(existing);
  }
  const landed = relative(root, join(realOrNull(existing) ?? existing, ...tail));
  const inside = landed !== "" && !landed.startsWith("..") && !isAbsolute(landed);
  const landedParts = inside ? landed.split(sep) : [];

  if (inside && namesState(landedParts)) {
    // Reached the state: only by the plain path, with no link on the way.
    let at = base;
    const crossed =
      at === null ||
      spelledParts.some((part) => {
        at = join(at!, part);
        return lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
      });
    if (crossed) throw new OpenQodexError(`${path} reaches the repo's .openqodex files through a symbolic link; name the file directly`);
    return landed;
  }
  return namesState(spelledParts) ? spelled : null;
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

// Each folder on the way that exists must be a real folder: a link throws
// the one-line reason before anything is written.
function refuseLinks(repoRoot: string, parts: string[]): void {
  let at = repoRoot;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (st === undefined) return;
    if (st.isSymbolicLink()) throw linkError(repoRoot, at);
    if (i < parts.length - 1 && !st.isDirectory()) throw new OpenQodexError(`${relative(repoRoot, at)} is not a folder`);
  }
}

// The guard for one write: the repository is the only folder it may write
// in, and a link anywhere in its work tree is refused (guarded-fs.ts). It
// decides by filesystem identity and writes through checked handles, so a
// link put in place after the check above is refused too.
function guardFor(repoRoot: string): Guard {
  return new Guard({ repoRoot: resolve(repoRoot), gitFolders: [], roots: [] });
}

// Writes `content` to `path` in the repo state, making the folders on the way.
// A link at the file or on the way throws. A temp file then a rename, so a
// reader never sees half a file; with `exclusive` the file is created only
// when nothing is there, and false says something was. Everything here can
// quote the code under review or decide a push, so a file is created 0600
// (or `mode`) and a folder 0700; a file it replaces, or a folder it writes
// in, that other users could read is closed and named once (closeWider).
export function writeRepoFile(repoRoot: string, path: string, content: string, opts: { exclusive?: boolean; mode?: number } = {}): boolean {
  const parts = steps(repoRoot, path);
  refuseLinks(repoRoot, parts);
  const guard = guardFor(repoRoot);
  return guard.write(join(resolve(repoRoot), ...parts), content, { exclusive: opts.exclusive, mode: opts.mode ?? 0o600, folderMode: 0o700, wider: closeWider(guard, resolve(repoRoot)) });
}

// Removes a file or an empty folder in the repo state; nothing when it is
// missing. A link at it or on the way throws, so nothing outside is touched.
export function removeRepoFile(repoRoot: string, path: string): void {
  const st = repoStat(repoRoot, path);
  if (st === null) return;
  const full = join(resolve(repoRoot), ...steps(repoRoot, path));
  if (!st.isDirectory()) guardFor(repoRoot).remove(full);
  else if (!guardFor(repoRoot).removeEmptyFolder(full)) throw new OpenQodexError(`${relative(repoRoot, full)} is not empty`);
}

// The names in a folder of the repo state; empty when it is missing.
export function listRepoDir(repoRoot: string, path: string): string[] {
  const st = repoStat(repoRoot, path);
  return st?.isDirectory() ? readdirSync(resolve(repoRoot, path)) : [];
}
