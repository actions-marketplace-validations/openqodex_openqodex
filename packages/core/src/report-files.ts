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
// Every read and write goes through repo-state.ts: no link is followed below
// the repo root, and every write is a temp file in the same folder, then a
// rename, because an agent may read a file while a second run writes it.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { closeWider, Guard } from "./guarded-fs.js";
import { readRepoFile, repoStat, writeRepoFile } from "./repo-state.js";
import type { Latest, Report, RunManifest, ScanResult } from "./types.js";

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

// Null for a missing, unreadable or corrupt file, and for one reached through
// a link: a run file is state openqodex wrote, so anything else is not it.
function readJson<T>(repoRoot: string, path: string): T | null {
  try {
    const text = readRepoFile(repoRoot, path);
    return text === null ? null : (JSON.parse(text) as T);
  } catch {
    return null;
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// The state folder with its .gitignore. A link at .openqodex, at reviews or
// at the .gitignore throws before anything is touched.
function ensureStateDir(repoRoot: string): string {
  repoStat(repoRoot, join(STATE_DIR, "reviews"));
  const ignore = join(STATE_DIR, ".gitignore");
  const current = readRepoFile(repoRoot, ignore);
  // Written when missing, and rewritten once from the Day 0 "*"; a file the
  // team edited is theirs.
  if (current === null || current === DAY0_GITIGNORE) writeRepoFile(repoRoot, ignore, STATE_GITIGNORE);
  return join(repoRoot, STATE_DIR);
}

function reviewsDir(repoRoot: string): string {
  return join(repoRoot, STATE_DIR, "reviews");
}

// Report folders directly under reviews/, newest first. Anything else in
// that folder is left alone.
function reportDirNames(repoRoot: string): string[] {
  let entries;
  try {
    if (!repoStat(repoRoot, reviewsDir(repoRoot))?.isDirectory()) return [];
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
  // Made 0700, as the files in them are 0600: a report quotes the code. One
  // an earlier version made 0755 is closed and named once.
  mkdirSync(reviewsDir(repoRoot), { recursive: true, mode: 0o700 });
  const had = repoStat(repoRoot, reviewsDir(repoRoot))!.mode & 0o777;
  if ((had & 0o077) !== 0) {
    const guard = new Guard({ repoRoot: resolve(repoRoot), gitFolders: [], roots: [] });
    closeWider(guard, resolve(repoRoot))(reviewsDir(repoRoot), had, "folder");
  }
  const stem = `${timestamp(new Date())}-${shortId}`;
  let name = stem;
  for (let n = 2; ; n++) {
    try {
      mkdirSync(join(reviewsDir(repoRoot), name), { mode: 0o700 });
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
    RECEIPTS.map((r) => readJson<Latest>(repoRoot, join(STATE_DIR, r))?.dir)
      .filter((d): d is string => typeof d === "string")
      .map((d) => basename(d)),
  );
  // rmSync removes a link itself and never follows one inside a folder.
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

// Writes each file atomically (temp file, then rename) into `dir`, a folder
// in the repo state, with `mode` for new files when given.
export function writeReportFiles(repoRoot: string, dir: string, files: Record<string, string>, mode?: number): void {
  for (const [name, content] of Object.entries(files)) {
    if (name !== basename(name) || name.startsWith(".")) throw new Error(`not a plain file name: ${name}`);
    writeRepoFile(repoRoot, join(dir, name), content, { mode });
  }
}

export function writeScan(repoRoot: string, dir: string, scan: ScanResult): void {
  writeRepoFile(repoRoot, join(dir, "scan.json"), json(scan));
}

export function readScan(repoRoot: string, dir: string): ScanResult | null {
  return readJson<ScanResult>(repoRoot, join(dir, "scan.json"));
}

export function writeManifest(repoRoot: string, dir: string, manifest: RunManifest): void {
  writeRepoFile(repoRoot, join(dir, "manifest.json"), json(manifest));
}

export function readManifest(repoRoot: string, dir: string): RunManifest | null {
  return readJson<RunManifest>(repoRoot, join(dir, "manifest.json"));
}

export function readReport(repoRoot: string, dir: string): Report | null {
  return readJson<Report>(repoRoot, join(dir, "report.json"));
}

// The review receipt. Only `review` writes it, so a scan never makes the push
// gate forget a finalized review of the same change.
export function writeLatest(repoRoot: string, latest: Latest): void {
  ensureStateDir(repoRoot);
  writeRepoFile(repoRoot, join(STATE_DIR, "latest.json"), json(latest));
}

// The scan receipt, read by nothing that decides a push.
export function writeLatestScan(repoRoot: string, latest: Latest): void {
  ensureStateDir(repoRoot);
  writeRepoFile(repoRoot, join(STATE_DIR, "latest-scan.json"), json(latest));
}

// The change review receipt, or with `all` the whole-repo one.
export function readLatest(repoRoot: string, all = false): Latest | null {
  return readJson<Latest>(repoRoot, join(STATE_DIR, all ? "latest-all.json" : "latest.json"));
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
  ensureStateDir(repoRoot);
  const rootConfig = repoStat(repoRoot, ".openqodex.yaml") !== null;
  const created: string[] = [];
  const create = (name: string, text: string): void => {
    if (writeRepoFile(repoRoot, join(STATE_DIR, name), text, { exclusive: true })) created.push(`${STATE_DIR}/${name}`);
  };
  if (!rootConfig) create(FOLDER_CONFIG, texts.config);
  create(INSTRUCTIONS_FILE, texts.instructions);
  return { created, rootConfig };
}
