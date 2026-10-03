// The repo folder `.openqodex/`. Two files in it are the team's, meant to be
// committed; the run state beside them is ignored by the folder's own
// `.gitignore`, so the developer's `.gitignore` is never edited. It lives in
// the repo because an agent sandbox can usually write only inside the
// workspace.
//
//   .openqodex/config.yaml               the team's config (created once, never touched after)
//   .openqodex/custom-instructions.md    what a reviewer of this repo must know (same)
//   .openqodex/.gitignore                the run state below
//   .openqodex/latest.json               the newest review: the push gate reads only this
//   .openqodex/latest-scan.json          the newest scan
//   .openqodex/reviews/<yyyymmdd-hhmmss>-<shortid>/   one folder per run
//
// Every write is a temp file in the same folder, then a rename, because an
// agent may read a file while a second run writes it.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Latest, Report, RunManifest, ScanResult } from "./types.js";
import { OpenQodexError } from "./types.js";

export const STATE_DIR = ".openqodex";
export const KEEP_REPORTS = 20;
export const FOLDER_CONFIG = "config.yaml";
export const INSTRUCTIONS_FILE = "custom-instructions.md";

// What the folder's .gitignore keeps out of git: the run state, not the two
// team files. The Day 0 file held only "*".
export const STATE_GITIGNORE = ["reviews/", "latest.json", "latest-scan.json", "latest-all.json", "last-report.json", "graph/", ""].join("\n");
const DAY0_GITIGNORE = "*\n";
// The review receipts: the change review and the whole-repo review.
const RECEIPTS = ["latest.json", "latest-all.json"];

// <yyyymmdd-hhmmss>-<shortid>, with "-2", "-3", ... for a second run of the
// same change in the same second.
const REPORT_DIR_NAME = /^(\d{8}-\d{6}-[0-9a-f]{12})(?:-(\d+))?$/;

function writeAtomic(path: string, content: string): void {
  const tmp = join(path, "..", `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// A repo could ship .openqodex, .openqodex/reviews or .openqodex/.gitignore as
// a symlink and send reads, writes and pruning somewhere else; refuse before
// touching anything.
function refuseSymlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return; // not there yet
  }
  if (isLink) throw new OpenQodexError(`${path} is a symbolic link; openqodex writes only to a real file or folder there`);
}

// A file's text, or null when it is absent, a link or not a regular file. A
// repo can commit any of these files as a link, and a link to an endless file
// such as /dev/zero would hang the read.
function readRegular(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null;
  } finally {
    closeSync(fd);
  }
}

function readJson<T>(path: string): T | null {
  const text = readRegular(path);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ensureStateDir(repoRoot: string): string {
  const dir = join(repoRoot, STATE_DIR);
  refuseSymlink(dir);
  refuseSymlink(join(dir, "reviews"));
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  refuseSymlink(ignore);
  const current = readRegular(ignore);
  // Written when missing, and rewritten once from the Day 0 "*"; a file the
  // team edited is theirs.
  if (current === null || current === DAY0_GITIGNORE) writeAtomic(ignore, STATE_GITIGNORE);
  return dir;
}

function reviewsDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, "reviews");
}

// Report folders directly under reviews/, newest first. Anything else in
// that folder is left alone.
function reportDirNames(repoRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(reviewsDir(repoRoot), { withFileTypes: true });
  } catch {
    return [];
  }
  const key = (name: string): [string, number] => {
    const m = REPORT_DIR_NAME.exec(name)!;
    return [m[1], m[2] === undefined ? 1 : Number(m[2])];
  };
  return entries
    .filter((e) => e.isDirectory() && REPORT_DIR_NAME.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => {
      const [ab, an] = key(a);
      const [bb, bn] = key(b);
      return ab === bb ? bn - an : ab < bb ? 1 : -1;
    });
}

function timestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

// Creates .openqodex/ (with its .gitignore) and a new report folder,
// keeps the newest 20, returns the absolute folder path.
export function openReportDir(repoRoot: string, shortId: string): string {
  if (!/^[0-9a-f]{12}$/.test(shortId)) throw new Error(`not a short change id: ${shortId}`);
  ensureStateDir(repoRoot);
  mkdirSync(reviewsDir(repoRoot), { recursive: true });
  const stem = `${timestamp(new Date())}-${shortId}`;
  let name = stem;
  for (let n = 2; ; n++) {
    try {
      mkdirSync(join(reviewsDir(repoRoot), name));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      name = `${stem}-${n}`;
    }
  }
  const dir = join(reviewsDir(repoRoot), name);
  // The folders the review receipts name are kept whatever their age: the
  // push gate and finalize read them.
  const pinned = new Set(
    RECEIPTS.map((r) => readJson<Latest>(join(repoRoot, STATE_DIR, r))?.dir)
      .filter((d): d is string => typeof d === "string")
      .map((d) => basename(d)),
  );
  for (const old of reportDirNames(repoRoot).filter((n) => n !== name && !pinned.has(n)).slice(KEEP_REPORTS - 1)) {
    rmSync(join(reviewsDir(repoRoot), old), { recursive: true, force: true });
  }
  return dir;
}

// The newest report folder for a change id, or null. Takes the full id or
// the 12-character short id.
export function findReportDir(repoRoot: string, changeId: string): string | null {
  const short = changeId.slice(0, 12);
  const name = reportDirNames(repoRoot).find((n) => REPORT_DIR_NAME.exec(n)![1].endsWith(`-${short}`));
  return name === undefined ? null : join(reviewsDir(repoRoot), name);
}

// Writes each file atomically (temp file, then rename).
export function writeReportFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    if (name !== basename(name) || name.startsWith(".")) throw new Error(`not a plain file name: ${name}`);
    writeAtomic(join(dir, name), content);
  }
}

export function writeScan(dir: string, scan: ScanResult): void {
  writeAtomic(join(dir, "scan.json"), json(scan));
}

export function readScan(dir: string): ScanResult | null {
  return readJson<ScanResult>(join(dir, "scan.json"));
}

export function writeManifest(dir: string, manifest: RunManifest): void {
  writeAtomic(join(dir, "manifest.json"), json(manifest));
}

export function readManifest(dir: string): RunManifest | null {
  return readJson<RunManifest>(join(dir, "manifest.json"));
}

export function readReport(dir: string): Report | null {
  return readJson<Report>(join(dir, "report.json"));
}

// The review receipt. Only `review` writes it, so a scan never makes the push
// gate forget a finalized review of the same change.
export function writeLatest(repoRoot: string, latest: Latest): void {
  writeAtomic(join(ensureStateDir(repoRoot), "latest.json"), json(latest));
}

// The scan receipt, read by nothing that decides a push.
export function writeLatestScan(repoRoot: string, latest: Latest): void {
  writeAtomic(join(ensureStateDir(repoRoot), "latest-scan.json"), json(latest));
}

// The change review receipt, or with `all` the whole-repo one.
export function readLatest(repoRoot: string, all = false): Latest | null {
  return readJson<Latest>(join(repoRoot, STATE_DIR, all ? "latest-all.json" : "latest.json"));
}

export type RepoFiles = {
  created: string[]; // repo-relative paths written by this call
  rootConfig: boolean; // a root .openqodex.yaml exists, so config.yaml was not created
};

// Creates .openqodex/config.yaml and .openqodex/custom-instructions.md when
// they do not exist, from the texts the caller passes. An existing file is
// never touched. No config.yaml while a root .openqodex.yaml exists: that
// file is still read, and two config files would make the team guess.
export function ensureRepoFiles(repoRoot: string, texts: { config: string; instructions: string }): RepoFiles {
  const dir = ensureStateDir(repoRoot);
  const rootConfig = existsSync(join(repoRoot, ".openqodex.yaml"));
  const created: string[] = [];
  const create = (name: string, text: string): void => {
    const path = join(dir, name);
    refuseSymlink(path);
    try {
      writeFileSync(path, text, { flag: "wx" });
      created.push(`${STATE_DIR}/${name}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  };
  if (!rootConfig) create(FOLDER_CONFIG, texts.config);
  create(INSTRUCTIONS_FILE, texts.instructions);
  return { created, rootConfig };
}
