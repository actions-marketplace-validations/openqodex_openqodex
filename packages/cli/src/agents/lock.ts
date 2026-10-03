// One lock file helper for install.lock, update.lock and update.json's lock.
// A lock file holds "<pid> <token>" and is created whole, through a hard link
// of a finished temp file, so it never reads half written. Release removes it
// only while it still holds the releaser's token.
//
// A lock whose pid is gone is stale. Only the holder of the guard file
// (<lock>.takeover, taken the same way) may remove a stale lock, and only
// after reading it again under the guard and finding the same dead holder.
// After that every taker races one exclusive link, so exactly one wins: two
// processes can never both take over one stale lock. A guard left by a
// process that died inside that few-line window is removed once its pid is
// gone and it is older than GUARD_STALE_MS.
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { errorCode } from "./files.js";

const GUARD_STALE_MS = 10_000;

type Holder = { pid: number; token: string };

function readHolder(path: string): Holder | null {
  try {
    const [pid = "", token = ""] = readFileSync(path, "utf8").trim().split(/\s+/);
    return Number.isInteger(Number(pid)) && Number(pid) > 0 ? { pid: Number(pid), token } : null;
  } catch {
    return null;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function linkExclusive(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }
}

function releaseIfMine(path: string, token: string): void {
  if (readHolder(path)?.token === token) rmSync(path, { force: true });
}

// Removes `lock` when it still holds the dead holder `seen`, under the guard.
function clearStale(lock: string, seen: Holder | null, mine: string, token: string): void {
  const guard = `${lock}.takeover`;
  if (!linkExclusive(mine, guard)) {
    const g = readHolder(guard);
    let age = 0;
    try {
      age = Date.now() - statSync(guard).mtimeMs;
    } catch {
      return;
    }
    if (g !== null && !isAlive(g.pid) && age > GUARD_STALE_MS) rmSync(guard, { force: true });
    return;
  }
  try {
    const now = readHolder(lock);
    const same = now === null ? seen === null : seen !== null && now.pid === seen.pid && now.token === seen.token;
    if (same && (now === null || !isAlive(now.pid))) rmSync(lock, { force: true });
  } finally {
    releaseIfMine(guard, token);
  }
}

// One attempt: the lock, or null when a live process holds it.
export function takeLock(lock: string): { token: string; release: () => void } | null {
  mkdirSync(dirname(lock), { recursive: true });
  const token = randomBytes(8).toString("hex");
  const mine = `${lock}.${token}.tmp`;
  const fd = openSync(mine, "wx", 0o600);
  try {
    writeSync(fd, `${process.pid} ${token}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (linkExclusive(mine, lock)) return { token, release: () => releaseIfMine(lock, token) };
      const holder = readHolder(lock);
      if (holder !== null && isAlive(holder.pid)) return null;
      clearStale(lock, holder, mine, token);
    }
    return null;
  } finally {
    rmSync(mine, { force: true });
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Waits up to `waitMs` for the lock; throws `busy` when it stays taken.
export async function waitLock(lock: string, waitMs: number, busy: string): Promise<{ token: string; release: () => void }> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = takeLock(lock);
    if (held !== null) return held;
    if (Date.now() > deadline) throw new Error(busy);
    await sleep(50);
  }
}

// The same, without awaiting: for a short read-change-write such as update.json.
export function waitLockSync(lock: string, waitMs: number, busy: string): { token: string; release: () => void } {
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const held = takeLock(lock);
    if (held !== null) return held;
    if (Date.now() > deadline) throw new Error(busy);
    Atomics.wait(pause, 0, 0, 10);
  }
}
