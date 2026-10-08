// Reading a file of the change inside the OpenQodex process. The working tree
// can hold anything a branch brought in: a symlink to /dev/zero or to a FIFO
// would hang or exhaust memory, and a symlink out of the repo would pull a
// file from elsewhere on the machine into a finding. So only a regular file
// that is inside the repo and under a size cap is read.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

// The path of a regular file inside `repoDir`, or a reason it is refused.
export async function repoFileOrReason(
  repoDir: string,
  rel: string,
  maxBytes: number,
): Promise<{ path: string; size: number } | { reason: string }> {
  const normalized = path.normalize(rel);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    return { reason: "outside the repo" };
  }
  const abs = path.join(repoDir, normalized);
  const stat = await fs.lstat(abs);
  if (!stat.isFile()) return { reason: "not a regular file" };
  // A directory on the way can still be a symlink out of the repo.
  const [realRepo, realFile] = await Promise.all([fs.realpath(repoDir), fs.realpath(abs)]);
  if (!realFile.startsWith(realRepo + path.sep)) return { reason: "outside the repo" };
  if (stat.size > maxBytes) return { reason: `larger than ${Math.round(maxBytes / (1024 * 1024))} MB` };
  return { path: abs, size: stat.size };
}

// Reads a regular file inside the repo as UTF-8. Throws with a plain reason
// for anything else.
export async function readRepoFile(repoDir: string, rel: string, maxBytes: number): Promise<string> {
  const checked = await repoFileOrReason(repoDir, rel, maxBytes);
  if ("reason" in checked) throw new Error(checked.reason);
  // O_NOFOLLOW and O_NONBLOCK: if the path was swapped for a symlink or a
  // FIFO after the check, the open fails or returns at once instead of hanging.
  const handle = await fs.open(checked.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

// True when every folder from the repo root down to `rel`'s own is a real
// folder, never a link, even one that stays inside the repo.
export function noLinkOnTheWay(repoDir: string, rel: string): boolean {
  const parts = path.normalize(rel).split(path.sep).slice(0, -1);
  let at = repoDir;
  for (const part of parts) {
    at = path.join(at, part);
    try {
      const stat = lstatSync(at);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// The same checks, synchronous, for at most the first `maxBytes` of a file,
// and stricter: no link anywhere on the way, not even one that stays inside
// the repo. `whole`: the file must fit in `maxBytes`, or nothing is read.
// Null for anything that is not a regular file inside the repo, or that
// cannot be read. `realRepo` is the repo's real path, computed once by the
// caller.
export function readRepoPrefixSync(realRepo: string, repoDir: string, rel: string, maxBytes: number, whole = false): Buffer | null {
  const normalized = path.normalize(rel);
  if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) return null;
  if (!noLinkOnTheWay(repoDir, normalized)) return null;
  const abs = path.join(repoDir, normalized);
  let fd: number | null = null;
  try {
    if (!lstatSync(abs).isFile()) return null;
    if (!realpathSync(abs).startsWith(realRepo + path.sep)) return null;
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (whole && stat.size > maxBytes)) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
