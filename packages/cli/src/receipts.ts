// The record the push hooks trust: one gate receipt per reviewed change, in
// the developer's own OpenQodex home, never in the repository. A branch can
// carry files under .openqodex/ (a force-added latest.json and report for
// its own commits); it cannot write here. Only `review` (at the end of a run
// of the developer's own change) and `review --finalize` (a legacy record)
// write it; the hooks only read it.
//
//   <home>/receipts/<repo id>/<change id>.json   one per reviewed change
//   <home>/receipts/<repo id>/latest.json        the newest, for its base
//   <home>/runs/<repo id>/<run id>.json          one per `review --agent` run
//
// A run record binds a legacy run (`review --agent`, then `review
// --finalize`) to this machine: the change id, the config and instructions
// hashes, and the sha256 of each run file `review --agent` wrote. Finalize
// writes a receipt only for a run whose files, change, config and
// instructions still match it, so a branch that carries a run folder of its
// own gets no receipt.
//
// The repo id is the sha256 of the repository's real root path. Folders are
// made 0700, files 0600, each written through the home guard
// (guarded-fs.ts): a temporary file renamed into place, in a folder that
// lies, by identity, under OpenQodex's home. A file that is a link, too
// large, or not a receipt reads as no record.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { GateReceipt } from "@openqodex/core";
import { closeWider } from "@openqodex/core";
import { homeGuard, type Guard } from "./agents/guarded-fs.js";

const MAX_BYTES = 64 * 1024;
const KEEP_MS = 30 * 24 * 3600_000;
const ID = /^([0-9a-f]{64}|latest)$/;
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{12}(?:-\d+)?$/;

export type RunRecord = {
  version: 1;
  change_id: string;
  config_hash: string;
  instructions_hash: string | null;
  manifest_sha256: string;
  scan_sha256: string;
  candidates_sha256: string;
  run_sha256: string;
  written_at: string;
};

function repoId(repoRoot: string): string {
  let real = repoRoot;
  try {
    real = realpathSync(repoRoot);
  } catch {
    // compared as given
  }
  return createHash("sha256").update(real).digest("hex");
}

function receiptsDir(home: string): string {
  return join(home, "receipts");
}

export function homeReceiptPath(home: string, repoRoot: string, changeId: string): string {
  return join(receiptsDir(home), repoId(repoRoot), `${changeId}.json`);
}

// Each named file written 0600 into <home>/<kind>/<repo id>/. A folder on
// the way that is a link, or leads outside OpenQodex's home, is refused.
function writeRecord(home: string, kind: string, repoRoot: string, names: string[], value: unknown): void {
  const guard = homeGuard(home);
  const dir = join(home, kind, repoId(repoRoot));
  const text = `${JSON.stringify(value, null, 2)}\n`;
  for (const name of names) guard.write(join(dir, name), text, { mode: 0o600, folderMode: 0o700, wider: closeWider(guard, home) });
}

// The parsed file, or null when it is not a regular file within the cap.
function readRecord(path: string): unknown {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function writeHomeReceipt(home: string, repoRoot: string, receipt: GateReceipt): void {
  if (!ID.test(receipt.change_id)) throw new Error("a receipt needs a full change id");
  writeRecord(home, "receipts", repoRoot, [`${receipt.change_id}.json`, "latest.json"], receipt);
}

export function homeRunPath(home: string, repoRoot: string, runId: string): string {
  return join(home, "runs", repoId(repoRoot), `${runId}.json`);
}

export function writeHomeRun(home: string, repoRoot: string, runId: string, run: RunRecord): void {
  if (!RUN_ID.test(runId) || !ID.test(run.change_id)) throw new Error("a run record needs a run name and a full change id");
  writeRecord(home, "runs", repoRoot, [`${runId}.json`], run);
}

// The run record of `runId`, or null.
export function readHomeRun(home: string, repoRoot: string, runId: string): RunRecord | null {
  if (!RUN_ID.test(runId)) return null;
  const value = readRecord(homeRunPath(home, repoRoot, runId)) as Partial<RunRecord> | null;
  const text = ["change_id", "config_hash", "manifest_sha256", "scan_sha256", "candidates_sha256", "run_sha256"] as const;
  const ok = value !== null && value.version === 1 && text.every((k) => typeof value[k] === "string") && (value.instructions_hash === null || typeof value.instructions_hash === "string");
  return ok ? (value as RunRecord) : null;
}

// The receipt of `changeId` ("latest" for the newest), or null.
export function readHomeReceipt(home: string, repoRoot: string, changeId: string): GateReceipt | null {
  if (!ID.test(changeId)) return null;
  const value = readRecord(homeReceiptPath(home, repoRoot, changeId)) as Partial<GateReceipt> | null;
  const ok =
    value !== null &&
    value.version === 1 &&
    typeof value.change_id === "string" &&
    (changeId === "latest" || value.change_id === changeId) &&
    (value.kind === "complete" || value.kind === "incomplete" || value.kind === "legacy") &&
    typeof value.report === "string" &&
    typeof value.base?.sha === "string" &&
    typeof value.base?.ref === "string";
  return ok ? (value as GateReceipt) : null;
}

// The newest `limit` receipts of this repository, newest first by the time
// each file was written. `latest.json` is left out, since it repeats one of
// them. A folder that is a link, or a file that is not a receipt, reads as
// none.
export function readHomeReceipts(home: string, repoRoot: string, limit: number): GateReceipt[] {
  const dir = join(receiptsDir(home), repoId(repoRoot));
  const named: { id: string; mtime: number }[] = [];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    for (const name of readdirSync(dir)) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (id === "latest" || !ID.test(id)) continue;
      try {
        named.push({ id, mtime: lstatSync(join(dir, name)).mtimeMs });
      } catch {
        // removed meanwhile
      }
    }
  } catch {
    return [];
  }
  named.sort((a, b) => b.mtime - a.mtime);
  const out: GateReceipt[] = [];
  for (const { id } of named.slice(0, limit)) {
    const receipt = readHomeReceipt(home, repoRoot, id);
    if (receipt !== null) out.push(receipt);
  }
  return out;
}

// Removes receipts and run records not written for 30 days, and repo
// folders left empty. Run by init and the foreground update, never by a hook.
// Each removal goes through the guard (guarded-fs.ts): it never follows a
// link and removes only under OpenQodex's home, by identity.
export function pruneHomeReceipts(home: string, now = Date.now(), guard: Guard = homeGuard(home)): void {
  for (const kind of ["receipts", "runs"]) pruneFolder(join(home, kind), now, guard);
}

// The repo folders of receipts and run records, as pruning sees them; a
// folder or root that is a link is not one.
function repoFolders(root: string): string[] {
  try {
    if (!lstatSync(root).isDirectory()) return [];
    return readdirSync(root)
      .map((repo) => join(root, repo))
      .filter((dir) => lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true);
  } catch {
    return [];
  }
}

// The receipts and run records pruneHomeReceipts would remove now.
export function staleReceipts(home: string, now = Date.now()): string[] {
  return ["receipts", "runs"]
    .flatMap((kind) => repoFolders(join(home, kind)))
    .flatMap((dir) => {
      try {
        return readdirSync(dir)
          .map((name) => join(dir, name))
          .filter((path) => now - lstatSync(path).mtimeMs > KEEP_MS);
      } catch {
        return [];
      }
    });
}

function pruneFolder(root: string, now: number, guard: Guard): void {
  for (const dir of repoFolders(root)) {
    try {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = lstatSync(path);
        if (now - st.mtimeMs > KEEP_MS) guard.remove(path);
      }
      if (readdirSync(dir).length === 0) guard.removeEmptyFolder(dir);
    } catch {
      // a folder that cannot be read, or a removal refused, is left alone
    }
  }
}
