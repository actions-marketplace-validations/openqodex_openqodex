// Switching the launcher to a runtime that is already unpacked, checked and
// in place under <home>/runtime/<version>/. Everything happens inside the
// installer's lock, after re-checking that updating is still allowed and that
// the active version is still the one the worker started from. The pointer
// is written last: a failure before it leaves the old version active.
import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { loadRecord, saveRecord, serialize, withLock, type InstallRecord } from "../agents/record.js";
import { bakedVersion, currentPath, readCurrent, runtimeBin, runtimeDir, writeCurrent } from "../launcher.js";
import { updateState, updatesAllowed } from "./state.js";

const execFileAsync = promisify(execFile);

// Runtimes younger than this are kept even when no rule below names them.
export const KEEP_YOUNG_MS = 7 * 24 * 60 * 60 * 1000;

export type ActivateResult = { ok: true; kept: string[] } | { ok: false; reason: string };

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

export async function activate(opts: { home: string; version: string; from: string; env: NodeJS.ProcessEnv }): Promise<ActivateResult> {
  const { home, version, from, env } = opts;
  try {
    return await withLock(home, async (): Promise<ActivateResult> => {
      const allowed = updatesAllowed(home, env);
      if (!allowed.allowed) return { ok: false, reason: `updates were turned ${allowed.why}` };
      const active = activeVersion(home);
      if (active !== from) return { ok: false, reason: `the active version is ${active ?? "unknown"}, not ${from}: another update or init ran` };
      if (!existsSync(runtimeBin(home, version))) return { ok: false, reason: `no runtime for ${version}` };

      let record = loadRecord(home);
      let before = serialize(record);
      if (!record.runtimes.includes(runtimeDir(version, home))) record.runtimes.push(runtimeDir(version, home));
      saveRecord(home, record, before);

      const refreshed = await refreshWith(home, version, env);
      writeCurrent(home, version);

      record = loadRecord(home);
      before = serialize(record);
      if (!record.pointers.includes(currentPath(home))) record.pointers.push(currentPath(home));
      // After this activation the previous one is `from`.
      const keep = new Set([version, from, bakedVersion(home) ?? ""].filter((v) => v !== ""));
      prune(home, record, keep, Date.now());
      saveRecord(home, record, before);

      updateState(home, { installed: version, previous: from, notified: false, lastError: null, kept: refreshed.kept });
      return { ok: true, kept: refreshed.kept };
    });
  } catch (error) {
    return { ok: false, reason: message(error) };
  }
}
