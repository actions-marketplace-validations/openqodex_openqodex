// The identity of a process and the graph folder's lock. One process at a
// time changes the folder's pointers, leases and meta: publish, lease,
// collect and updateMeta each hold the lock for a short critical section.
// The lock is a file created exclusively that names its holder: the pid, the
// time the process started and the time the lock was taken. A waiter takes
// it over when the holder is gone: the pid is dead, the pid now belongs to a
// process that started at another time (the pid was reused), or the lock is
// older than 60 seconds. Waiting is a loop of awaited sleeps, so no timer is
// left pending once the wait ends (the 2026-10-02 trap).
//
// The lock and the takeover marker are files only openqodex makes.
// Anything else at their names (a folder, a link, a pipe) would make every
// waiter wait its full time and fail, forever: such an entry is removed
// when that is safe (not a link, this user's, older than the stale
// window), and otherwise the lock is refused with one plain line, so the
// build is kept in memory and says why (clearMalformed).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { Guard } from "@openqodex/core";

export const LOCK_WAIT_MS = 10_000;
export const LOCK_STALE_MS = 60_000;
// A takeover marker left by a process that died while taking a lock over.
const TAKEOVER_STALE_MS = 10_000;
const LOCK_FILE = "lock";
const TAKEOVER_FILE = "lock.takeover";
const MAX_PID = 4_194_304;

export type Holder = { pid: number; start: string; time: number };

export function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pid <= MAX_PID;
}

let psMissing = false;

// When `pid` started, as `ps -o lstart=` prints it in the C locale with its
// spaces folded; null when ps is missing or does not know the pid.
export function processStart(pid: number): Promise<string | null> {
  if (psMissing || !validPid(pid)) return Promise.resolve(null);
  return new Promise((done) => {
    execFile("ps", ["-o", "lstart=", "-p", String(pid)], { env: { ...process.env, LC_ALL: "C" }, timeout: 5000 }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") psMissing = true;
      const text = String(stdout).trim().replace(/\s+/g, " ");
      done(error !== null || text === "" ? null : text);
    });
  });
}

// This process's own start time, asked once; "" when ps cannot tell, and
// then liveness is the signal check alone.
let own: Promise<string> | null = null;
export function ownStart(): Promise<string> {
  own ??= processStart(process.pid).then((s) => s ?? "");
  return own;
}

function signalAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// True when the process that wrote `start` for `pid` still runs: the pid is
// alive and, when both start times are known, they are the same.
export async function holderAlive(pid: number, start: string): Promise<boolean> {
  if (!validPid(pid) || !signalAlive(pid)) return false;
  if (start === "") return true;
  const now = pid === process.pid ? await ownStart() : await processStart(pid);
  // ps could not tell (missing, refused, or the process ended just now):
  // the signal check decides.
  if (now === null || now === "") return signalAlive(pid);
  return now === start;
}

// A short tag of a start time for a file name: the name only helps a
// person; the file's content is what is checked.
export function startTag(start: string): string {
  return start === "" ? "0" : createHash("sha1").update(start).digest("hex").slice(0, 8);
}

export function parseHolder(data: Buffer | null): Holder | null {
  if (data === null) return null;
  try {
    const v = JSON.parse(data.toString("utf8")) as Partial<Holder>;
    if (validPid(v.pid) && typeof v.start === "string" && v.start.length <= 200 && typeof v.time === "number" && Number.isFinite(v.time)) {
      return { pid: v.pid, start: v.start, time: v.time };
    }
  } catch {
    // half written or not ours: judged by its age
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function inodeOf(path: string): bigint | null {
  const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  return st?.isFile() ? st.ino : null;
}

export class HeldLock {
  private released = false;
  constructor(
    private guard: Guard,
    private path: string,
    private ino: bigint,
  ) {}

  // Removes the lock file when it is still the one this process made; a
  // lock taken over meanwhile is left to its new holder.
  release(): void {
    if (this.released) return;
    this.released = true;
    removeIfSame(this.guard, this.path, this.ino);
  }
}

function removeIfSame(guard: Guard, path: string, ino: bigint): void {
  try {
    if (inodeOf(path) === ino) guard.remove(path);
  } catch {
    // gone already, or no longer a file openqodex may remove
  }
}

// Makes the lock's two names in the folder `dir` free or regular files:
// anything else there is removed through the guard when it is not a link,
// this user owns it and it is older than the lock's stale window. Returns
// null when both names are usable, else why not, as one plain line naming
// the entry by `shown` (the folder as the developer sees it).
export function clearMalformed(guard: Guard, dir: string, shown: string): string | null {
  for (const name of [LOCK_FILE, TAKEOVER_FILE]) {
    const path = join(dir, name);
    const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (st === undefined || st.isFile()) continue;
    const what = st.isSymbolicLink() ? "a symbolic link" : st.isDirectory() ? "a folder" : "not a regular file";
    const at = `${shown}/${name} is ${what} where openqodex keeps its lock file`;
    if (st.isSymbolicLink()) return `${at}: remove the link`;
    const uid = process.getuid?.();
    if (uid !== undefined && Number(st.uid) !== uid) return `${at}, and another user owns it: remove it`;
    if (Date.now() - Number(st.mtimeMs) <= LOCK_STALE_MS) return `${at}, made under a minute ago: remove it once nothing uses it`;
    try {
      guard.removeTree(path);
    } catch (error) {
      return `${at}, and it could not be removed (${error instanceof Error ? error.message : String(error)}): remove it`;
    }
  }
  return null;
}

export class FolderLock {
  // `read` returns a small file of the folder, opened without following a
  // link; null when it is not a regular file there. `shown` names the
  // folder in a refusal.
  constructor(
    private guard: Guard,
    private dir: string,
    private read: (name: string) => Buffer | null,
    private shown: string,
  ) {}

  // Takes the lock, waiting up to `waitMs`; null when another live holder
  // kept it all that time. Throws at once, with the reason, when the lock
  // file cannot be made at all (a link or a folder in its place or in the
  // takeover marker's that is not safe to remove, a full disk).
  async acquire(waitMs = LOCK_WAIT_MS): Promise<HeldLock | null> {
    const malformed = clearMalformed(this.guard, this.dir, this.shown);
    if (malformed !== null) throw new Error(malformed);
    const start = await ownStart();
    const path = join(this.dir, LOCK_FILE);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const body = `${JSON.stringify({ pid: process.pid, start, time: Date.now() } satisfies Holder)}\n`;
      if (this.guard.write(path, body, { exclusive: true })) {
        const ino = inodeOf(path);
        if (ino !== null) return new HeldLock(this.guard, path, ino);
      } else {
        await this.takeOverIfStale(path);
      }
      if (Date.now() >= deadline) return null;
      await sleep(10 + Math.floor(Math.random() * 30));
    }
  }

  // The inode of the lock when its holder is gone; null when the lock is
  // live, missing, or changed while it was read.
  private async staleLock(path: string): Promise<bigint | null> {
    const st = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (st === undefined || !st.isFile()) return null;
    const holder = parseHolder(this.read(LOCK_FILE));
    if (inodeOf(path) !== st.ino) return null;
    // Lock and holder times are wall-clock times, never the store's
    // injected clock: the lock is shared with other processes.
    const age = Date.now() - (holder === null ? Number(st.mtimeMs) : holder.time);
    if (age > LOCK_STALE_MS) return st.ino;
    if (holder === null) return null;
    return (await holderAlive(holder.pid, holder.start)) ? null : st.ino;
  }

  // One waiter at a time takes a stale lock over: it makes the takeover
  // marker exclusively, checks again that the same lock is still stale,
  // and removes it. Without the marker, two waiters that both saw the stale
  // lock could each remove it, the second one removing the first one's
  // fresh lock.
  private async takeOverIfStale(path: string): Promise<void> {
    if ((await this.staleLock(path)) === null) return;
    const marker = join(this.dir, TAKEOVER_FILE);
    const body = `${JSON.stringify({ pid: process.pid, start: await ownStart(), time: Date.now() } satisfies Holder)}\n`;
    let made: boolean;
    try {
      made = this.guard.write(marker, body, { exclusive: true });
    } catch {
      // A link or a folder put there since acquire checked: the reason, at
      // once, rather than a wait that can only end busy. Anything else is
      // tried again on the next round.
      const malformed = clearMalformed(this.guard, this.dir, this.shown);
      if (malformed !== null) throw new Error(malformed);
      return;
    }
    if (!made) {
      const st = lstatSync(marker, { bigint: true, throwIfNoEntry: false });
      if (st !== undefined && !st.isFile()) {
        const malformed = clearMalformed(this.guard, this.dir, this.shown);
        if (malformed !== null) throw new Error(malformed);
        return;
      }
      if (st?.isFile() && Date.now() - Number(st.mtimeMs) > TAKEOVER_STALE_MS) removeIfSame(this.guard, marker, st.ino);
      return;
    }
    const mine = inodeOf(marker);
    try {
      const stale = await this.staleLock(path);
      if (stale !== null) removeIfSame(this.guard, path, stale);
    } finally {
      if (mine !== null) removeIfSame(this.guard, marker, mine);
    }
  }
}
