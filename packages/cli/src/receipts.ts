// The record the push hooks trust: one gate receipt per reviewed change, in
// the developer's own OpenQodex home, never in the repository. A branch can
// carry files under .openqodex/ (a force-added latest.json and report for
// its own commits); it cannot write here. Only `review` (at the end of a run
// of the developer's own change) and `review --finalize` (a legacy record)
// write it; the hooks only read it.
//
//   <home>/receipts/<repo id>/<change id>.json   one per reviewed change
//   <home>/receipts/<repo id>/latest.json        the newest, for its base
//
// The repo id is the sha256 of the repository's real root path. Folders are
// 0700 and real (never a link), files 0600, written to a fresh temporary
// file and renamed into place. A file that is a link, too large, or not a
// receipt reads as no record.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateReceipt } from "@openqodex/core";

const MAX_BYTES = 64 * 1024;
const KEEP_MS = 30 * 24 * 3600_000;
const ID = /^([0-9a-f]{64}|latest)$/;

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

// A real folder made 0700, or an error: never written through a link.
function realFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} is not a real folder`);
}

export function writeHomeReceipt(home: string, repoRoot: string, receipt: GateReceipt): void {
  if (!ID.test(receipt.change_id)) throw new Error("a receipt needs a full change id");
  realFolder(home);
  realFolder(receiptsDir(home));
  const dir = join(receiptsDir(home), repoId(repoRoot));
  realFolder(dir);
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  for (const name of [`${receipt.change_id}.json`, "latest.json"]) {
    const tmp = join(dir, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    renameSync(tmp, join(dir, name));
  }
}

// The receipt of `changeId` ("latest" for the newest), or null.
export function readHomeReceipt(home: string, repoRoot: string, changeId: string): GateReceipt | null {
  if (!ID.test(changeId)) return null;
  const path = homeReceiptPath(home, repoRoot, changeId);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<GateReceipt>;
    const ok =
      value.version === 1 &&
      typeof value.change_id === "string" &&
      (changeId === "latest" || value.change_id === changeId) &&
      (value.kind === "complete" || value.kind === "incomplete" || value.kind === "legacy") &&
      typeof value.report === "string" &&
      typeof value.base?.sha === "string" &&
      typeof value.base?.ref === "string";
    return ok ? (value as GateReceipt) : null;
  } catch {
    return null;
  }
}

// Removes receipts not written for 30 days, and repo folders left empty.
// Run by init and the foreground update, never by a hook.
export function pruneHomeReceipts(home: string, now = Date.now()): void {
  const root = receiptsDir(home);
  let repos: string[];
  try {
    if (!lstatSync(root).isDirectory()) return;
    repos = readdirSync(root);
  } catch {
    return;
  }
  for (const repo of repos) {
    const dir = join(root, repo);
    try {
      if (!lstatSync(dir).isDirectory()) continue;
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = lstatSync(path);
        if (now - st.mtimeMs > KEEP_MS) rmSync(path, { force: true });
      }
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      // a folder that cannot be read is left alone
    }
  }
}
