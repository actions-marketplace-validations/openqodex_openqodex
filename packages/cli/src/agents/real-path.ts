// Where a write by init really lands, decided from the real location and
// never from the spelling. A path is walked the way the system walks it:
// one name at a time from the root, a link followed where it stands, and
// `.` and `..` taken after the links before them, so `repo/link/../x` is
// where the link leads, not `repo/x`. Then:
//
// - a link whose own place is in the repository's work tree (outside its git
//   folders, which nothing committed can reach) is refused: the repository
//   decides where it points. A link anywhere else is the developer's own (a
//   dotfiles repo links ~/.claude/settings.json) and is followed;
// - the place reached must lie in one of the folders init may write (the
//   work tree, its git folders, the home folder, the agents' own folders,
//   OpenQodex's home), compared by whole names, with case folded only when
//   the volume folds it (trace.ts asks the volume);
// - the write goes to that same resolved place, and the path is walked again
//   right before the atomic rename: a link put in between changes the place
//   or is refused, and the write stops.
import { chmodSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { foldsCase, within } from "../reviewers/trace.js";
import { errorCode } from "./files.js";

export type WriteRoots = {
  // The repository's work tree; null outside a repository.
  repoRoot: string | null;
  // Its git folders: inside the work tree, never reached by a commit.
  gitFolders: string[];
  // Every other folder init may write: the home folder, the agents' own
  // folders, OpenQodex's home.
  roots: string[];
};

const MAX_LINKS = 40;

// The place `path` names, walked as the system walks it. `followLast`: a
// link as the last name is followed too (where a write lands), or kept (the
// link itself, which a removal takes). `onLink` sees each link's own place
// before it is followed. A `..` after a name that does not exist is refused:
// the system would stop there, while a folder created for it would not.
function walk(path: string, followLast: boolean, onLink: (place: string) => void): string {
  if (!isAbsolute(path)) throw new Error(`${path} is not an absolute path`);
  let parts = path.split(sep);
  let at: string = sep;
  let links = 0;
  let missing = false;
  while (parts.length > 0) {
    const name = parts.shift()!;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      if (missing) throw new Error(`${path} climbs with .. out of a folder that does not exist`);
      at = dirname(at);
      continue;
    }
    const next = join(at, name);
    if (missing) {
      at = next;
      continue;
    }
    let link = false;
    try {
      link = lstatSync(next).isSymbolicLink();
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
      missing = true;
    }
    const last = parts.every((p) => p === "" || p === ".");
    if (!link || (last && !followLast)) {
      at = next;
      continue;
    }
    onLink(next);
    if (++links > MAX_LINKS) throw new Error(`more than ${MAX_LINKS} symbolic links on the way to ${path}`);
    const target = readlinkSync(next);
    parts = [...target.split(sep), ...parts];
    if (isAbsolute(target)) at = sep;
  }
  return at;
}

// A folder's real place, for comparing places with it.
function placeOf(dir: string): string {
  return walk(dir, true, () => undefined);
}

function under(root: string, place: string): boolean {
  return within(root, place, foldsCase(root));
}

export type Checked = {
  // Where a write lands: every link followed.
  real: string;
  // The last name itself, a link kept as a link: what a removal takes.
  self: string;
};

// The real places of a write to `path`, or the reason it is refused.
export function checkWrite(path: string, w: WriteRoots): Checked {
  const repo = w.repoRoot === null ? null : placeOf(w.repoRoot);
  const git = w.gitFolders.map(placeOf);
  const roots = [...(repo === null ? [] : [repo]), ...git, ...w.roots.map(placeOf)];
  const refuseRepoLink = (place: string): void => {
    if (repo !== null && under(repo, place) && !git.some((g) => under(g, place))) {
      throw new Error(`${place} is a symbolic link inside the repository; openqodex does not write through links the repository holds`);
    }
  };
  const real = walk(path, true, refuseRepoLink);
  const self = walk(path, false, refuseRepoLink);
  for (const place of [real, self]) {
    if (!roots.some((r) => under(r, place))) throw new Error(`${path} lands at ${place}, outside every folder openqodex init writes to`);
  }
  return { real, self };
}

// Writes `content` where `path` really lands, by a temp file and a rename in
// that folder. An existing file keeps its mode; a new one gets `mode`
// (default 0644). The path is walked again right before the rename, and the
// write stops when it no longer lands in the same place.
export function writeChecked(path: string, content: string, w: WriteRoots, mode?: number): void {
  const { real } = checkWrite(path, w);
  mkdirSync(dirname(real), { recursive: true });
  let keep: number | null = null;
  try {
    keep = statSync(real).mode & 0o7777;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o644, flag: "wx" });
    if (keep !== null) chmodSync(tmp, keep);
    if (checkWrite(path, w).real !== real) throw new Error(`${path} changed while init was writing it; nothing written`);
    renameSync(tmp, real);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Removes the file `path` names (a link as itself), once the path passes
// the same check as a write.
export function removeChecked(path: string, w: WriteRoots): string {
  const { self } = checkWrite(path, w);
  rmSync(self, { force: true });
  return self;
}
