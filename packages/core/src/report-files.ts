// Contract stub. The owning stream replaces this file; the exported names and
// signatures are frozen (see packages/core/src/types.ts).
import type { Latest, Report, RunManifest, ScanResult } from "./types.js";

const notBuilt = (name: string): never => {
  throw new Error(`${name} is not built yet`);
};

// Creates .openqodex/ (with a .gitignore holding "*") and a new report folder,
// keeps the newest 20, returns the absolute folder path.
export function openReportDir(_repoRoot: string, _shortId: string): string {
  return notBuilt("openReportDir");
}

// The newest report folder for a change id, or null.
export function findReportDir(_repoRoot: string, _changeId: string): string | null {
  return notBuilt("findReportDir");
}

// Writes each file atomically (temp file, then rename).
export function writeReportFiles(_dir: string, _files: Record<string, string>): void {
  notBuilt("writeReportFiles");
}

export function writeScan(_dir: string, _scan: ScanResult): void {
  notBuilt("writeScan");
}

export function readScan(_dir: string): ScanResult | null {
  return notBuilt("readScan");
}

export function writeManifest(_dir: string, _manifest: RunManifest): void {
  notBuilt("writeManifest");
}

export function readManifest(_dir: string): RunManifest | null {
  return notBuilt("readManifest");
}

export function readReport(_dir: string): Report | null {
  return notBuilt("readReport");
}

export function writeLatest(_repoRoot: string, _latest: Latest): void {
  notBuilt("writeLatest");
}

export function readLatest(_repoRoot: string): Latest | null {
  return notBuilt("readLatest");
}
