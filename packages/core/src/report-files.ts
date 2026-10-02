// Run state inside the repo: `.openqodex/`, ignored by its own `.gitignore`
// so the developer's `git status` never changes and their `.gitignore` is
// never edited. It lives in the repo because an agent sandbox can usually
// write only inside the workspace.
//
//   .openqodex/.gitignore            "*"
//   .openqodex/latest.json           the newest run
//   .openqodex/reviews/<yyyymmdd-hhmmss>-<shortid>/   one folder per run
//
// Every write is a temp file in the same folder, then a rename, because an
// agent may read a file while a second run writes it.
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Latest, Report, RunManifest, ScanResult } from "./types.js";
import { OpenQodexError } from "./types.js";

export const STATE_DIR = ".openqodex";
export const KEEP_REPORTS = 20;

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

// A repo could ship .openqodex or .openqodex/reviews as a symlink and send
// writes and pruning somewhere else; refuse before touching anything.
function refuseSymlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return; // not there yet
  }
  if (isLink) throw new OpenQodexError(`${path} is a symbolic link; openqodex writes only to a real folder there`);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
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
  let current: string | null = null;
  try {
    current = readFileSync(ignore, "utf8");
  } catch {
    // not there yet
  }
  if (current !== "*\n") writeAtomic(ignore, "*\n");
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

// Creates .openqodex/ (with a .gitignore holding "*") and a new report folder,
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
  for (const old of reportDirNames(repoRoot).filter((n) => n !== name).slice(KEEP_REPORTS - 1)) {
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

export function writeLatest(repoRoot: string, latest: Latest): void {
  writeAtomic(join(ensureStateDir(repoRoot), "latest.json"), json(latest));
}

export function readLatest(repoRoot: string): Latest | null {
  return readJson<Latest>(join(repoRoot, STATE_DIR, "latest.json"));
}
