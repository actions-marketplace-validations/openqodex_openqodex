// Switching the launcher to a runtime that is already unpacked, checked and
// in place under <home>/runtime/<version>/. Everything happens inside the
// installer's lock, after re-checking that updating is still allowed and that
// the active version is still the one the worker started from. The pointer
// is written last: a failure before it leaves the old version active.
import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadRecord, saveRecord, serialize, withLock, type InstallRecord } from "../agents/record.js";
import { bakedVersion, currentPath, readCurrent, runtimeBin, runtimeDir, sameTree, writeCurrent } from "../launcher.js";
import { readState, updateState, updatesAllowed } from "./state.js";

const execFileAsync = promisify(execFile);

// Runtimes younger than this are kept even when no rule below names them.
export const KEEP_YOUNG_MS = 7 * 24 * 60 * 60 * 1000;

// `skip`: the release itself cannot be used here; the worker records it.
export type ActivateResult = { ok: true; kept: string[] } | { ok: false; reason: string; skip?: boolean };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
}

// The version the launcher runs now: `current` when its runtime is there,
// else the version baked into the launcher, as the launcher itself decides.
export function activeVersion(home: string): string | null {
  const current = readCurrent(home);
  if (current !== null && existsSync(runtimeBin(home, current))) return current;
  return bakedVersion(home);
}

// Runs `<runtime> __refresh`: that runtime rewrites the agent files the
// record names and that are still exactly as written, from its own
// templates. The caller holds install.lock; the child does not take it.
export async function refreshWith(home: string, version: string, env: NodeJS.ProcessEnv): Promise<{ updated: string[]; kept: string[] }> {
  const { stdout } = await execFileAsync(process.execPath, [runtimeBin(home, version), "__refresh"], {
    env: { ...env, OPENQODEX_HOME: home },
    timeout: 60_000,
  });
  const parsed = JSON.parse(stdout) as { updated?: unknown; kept?: unknown };
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { updated: list(parsed.updated), kept: list(parsed.kept) };
}

// Removes recorded runtimes that no rule keeps: the baked-in one, the
// current one, the previous one, and any younger than 7 days stay. A folder
// the record does not name is never touched.
function prune(home: string, record: InstallRecord, keep: Set<string>, now: number): void {
  const runtimes = join(home, "runtime");
  for (const dir of record.runtimes) {
    if (dirname(dir) !== runtimes || keep.has(basename(dir))) continue;
    let mtime: number;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      record.runtimes = record.runtimes.filter((r) => r !== dir);
      continue;
    }
    if (now - mtime < KEEP_YOUNG_MS) continue;
    rmSync(dir, { recursive: true, force: true });
    record.runtimes = record.runtimes.filter((r) => r !== dir);
  }
}

// Test seam, honoured only with OPENQODEX_E2E=1: stops for good at a named
// stage after writing <home>/update-paused, so a test can kill the process
// there.
async function pauseAt(home: string, stage: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.OPENQODEX_E2E !== "1" || env.OPENQODEX_UPDATE_PAUSE !== stage) return;
  writeFileSync(join(home, "update-paused"), `${stage}\n`);
  await new Promise(() => setInterval(() => undefined, 60_000));
}

// Puts the verified copy at runtime/<version>. An existing folder of that
// version is kept only when every file equals the verified copy; otherwise it
// is replaced, unless it is the runtime the launcher runs now.
function publish(home: string, version: string, unpacked: string, active: string | null): string | null {
  const target = runtimeDir(version, home);
  if (existsSync(target)) {
    if (sameTree(unpacked, target)) return null;
    if (version === active) return `a different copy of ${version} is installed and running; it was left as it is`;
  }
  const old = `${target}.old-${process.pid}`;
  if (existsSync(target)) renameSync(target, old);
  renameSync(unpacked, target);
  rmSync(old, { recursive: true, force: true });
  // The tarball's own times are from 1985; the age rule counts from now.
  const now = new Date();
  utimesSync(target, now, now);
  return null;
}

// Saves what an activation that reached the pointer still owes: the runtime
// and the pointer in the record, `previous` and the notice in the state.
function finishBookkeeping(home: string, from: string, to: string, kept: string[]): void {
  const record = loadRecord(home);
  const before = serialize(record);
  if (!record.runtimes.includes(runtimeDir(to, home))) record.runtimes.push(runtimeDir(to, home));
  if (!record.pointers.includes(currentPath(home))) record.pointers.push(currentPath(home));
  saveRecord(home, record, before);
  updateState(home, { installed: to, previous: from, notified: false, lastError: null, kept, activation: null });
}

// After a crash: an activation journaled in update.json is finished when the
// pointer names its new version, and dropped otherwise. The caller holds
// install.lock, or this takes it.
export function reconcileLocked(home: string): void {
  const journal = readState(home).activation;
  if (journal === null) return;
  if (readCurrent(home) === journal.to) finishBookkeeping(home, journal.from, journal.to, []);
  else updateState(home, { activation: null });
}

export async function reconcile(home: string): Promise<void> {
  await withLock(home, async () => reconcileLocked(home));
}

// Removing old runtimes never changes the outcome of a switch that is done.
function pruneAfter(home: string, keep: Set<string>): void {
  try {
    const record = loadRecord(home);
    const before = serialize(record);
    prune(home, record, keep, Date.now());
    saveRecord(home, record, before);
  } catch {
    // tried again after the next update
  }
}

// `unpacked`: the verified package folder the worker unpacked, published here
// under install.lock. Without it the runtime must already be in place.
export async function activate(opts: { home: string; version: string; from: string; env: NodeJS.ProcessEnv; unpacked?: string }): Promise<ActivateResult> {
  const { home, version, from, env, unpacked } = opts;
  try {
    return await withLock(home, async (): Promise<ActivateResult> => {
      reconcileLocked(home);
      const allowed = updatesAllowed(home, env);
      if (!allowed.allowed) return { ok: false, reason: `updates were turned ${allowed.why}` };
      const active = activeVersion(home);
      if (active !== from) return { ok: false, reason: `the active version is ${active ?? "unknown"}, not ${from}: another update or init ran` };
      if (unpacked !== undefined) {
        const refused = publish(home, version, unpacked, active);
        if (refused !== null) return { ok: false, reason: refused, skip: true };
      }
      if (!existsSync(runtimeBin(home, version))) return { ok: false, reason: `no runtime for ${version}` };

      const record = loadRecord(home);
      const before = serialize(record);
      if (!record.runtimes.includes(runtimeDir(version, home))) record.runtimes.push(runtimeDir(version, home));
      saveRecord(home, record, before);

      // All or nothing: a failed refresh has put back what it wrote.
      const refreshed = await refreshWith(home, version, env);
      updateState(home, { activation: { from, to: version } });
      await pauseAt(home, "before-pointer", env);
      writeCurrent(home, version);
      await pauseAt(home, "after-pointer", env);
      finishBookkeeping(home, from, version, refreshed.kept);
      // After this activation the previous one is `from`.
      pruneAfter(home, new Set([version, from, bakedVersion(home) ?? ""].filter((v) => v !== "")));
      return { ok: true, kept: refreshed.kept };
    });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
}
