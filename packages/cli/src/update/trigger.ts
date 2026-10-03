// What runs after every command: the one-line notices on stderr, and the
// start of a detached update worker after `review`, `scan`, `hook check` and
// `hook pre-push` run through the launcher. It reads two small files and at
// most spawns a process: no timer, no network, no lock wait. It never throws
// and never touches the exit code or stdout.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { openqodexHome } from "@openqodex/scanners";
import { launcherStarted } from "../launcher.js";
import { readState, updateState, updatesAllowed, type UpdateState } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = DAY_MS;
const TRUST_NOTICE_EVERY_MS = 7 * DAY_MS;

function ageMs(iso: string | null, now: number): number {
  const at = iso === null ? Number.NaN : Date.parse(iso);
  return Number.isFinite(at) ? now - at : Number.POSITIVE_INFINITY;
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

function days(ms: number): string {
  const n = Math.floor(ms / DAY_MS);
  return n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
}

// For a pinned run (npx, a project-scope file): one line when the state a
// launcher install left says a newer version is out. Nothing without state.
export function pinnedNote(state: UpdateState, running: string, now = Date.now()): string | null {
  if (state.latestSeen === null || !newer(state.latestSeen, running)) return null;
  return `the pinned version ${running} is behind ${state.latestSeen} (seen ${days(ageMs(state.latestSeenAt, now))})`;
}

// Starts the worker when a check is due, exactly as the scanner installs start
// theirs: detached, no stdio, spawn errors swallowed, unref'd.
export function maybeStartUpdate(home: string, state: UpdateState): void {
  if (!updatesAllowed(home, process.env).allowed) return;
  // A check time in the future (a clock that moved back) counts as due.
  const age = ageMs(state.checkedAt, Date.now());
  if (age >= 0 && age < CHECK_EVERY_MS) return;
  const entry = process.argv[1];
  if (entry === undefined) return;
  const child = spawn(process.execPath, [resolve(entry), "__update"], {
    cwd: homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OPENQODEX_HOME: home },
  });
  child.once("error", () => undefined);
  child.unref();
}

function notices(home: string, state: UpdateState): void {
  const now = Date.now();
  if (!state.notified && state.installed === __OPENQODEX_VERSION__ && state.previous !== null) {
    process.stderr.write(`openqodex updated to ${state.installed} (was ${state.previous}). Roll back: openqodex update --rollback\n`);
    updateState(home, { notified: true });
  }
  if (state.trustFailedAt !== null && ageMs(state.trustNoticeAt, now) >= TRUST_NOTICE_EVERY_MS) {
    process.stderr.write(
      `openqodex cannot verify new releases with its built-in trust data; it stays on ${__OPENQODEX_VERSION__}. To update by hand: npx openqodex@latest init\n`,
    );
    updateState(home, { trustNoticeAt: new Date(now).toISOString() });
  }
}

export function afterCommand(name: string, args: string[]): void {
  try {
    // A finalize handed to the runtime that wrote the brief: its parent speaks.
    if (process.env.OPENQODEX_REEXEC === "1") return;
    const home = openqodexHome();
    const state = readState(home);
    const sub = name === "hook" ? args[0] : undefined;
    if (!launcherStarted()) {
      const note = name === "review" || name === "scan" ? pinnedNote(state, __OPENQODEX_VERSION__) : null;
      if (note !== null) process.stderr.write(`openqodex: ${note}\n`);
      return;
    }
    // The agent hook's stderr is not shown on success, so a notice there
    // would be marked as seen without being seen.
    if (!(name === "hook" && sub === "check")) notices(home, state);
    if (name === "review" || name === "scan" || (name === "hook" && (sub === "check" || sub === "pre-push"))) maybeStartUpdate(home, state);
  } catch {
    // Updating is never a reason for a command to fail.
  }
}
