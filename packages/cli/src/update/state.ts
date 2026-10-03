// The self-update's state, <home>/update.json, and its switch. The state is
// a cache: unreadable or unparsable state reads as empty, and the worst a
// lost state costs is one extra check. The switch fails safe: a user config
// that does not parse turns updating off.
import { join } from "node:path";
import { parseDocument } from "yaml";
import { readText, sha256, writeAtomic } from "../agents/files.js";
import { takeLock, waitLockSync } from "../agents/lock.js";

export type UpdateState = {
  // When a worker last started a check (ISO time); the trigger waits 24 hours after it.
  checkedAt: string | null;
  // The registry's latest version at the last successful check, and when.
  latestSeen: string | null;
  latestSeenAt: string | null;
  // The version the last activation installed, and the one active before it.
  installed: string | null;
  previous: string | null;
  lastError: string | null;
  // Releases that failed verification or could not be activated, with when.
  skipped: { version: string; reason: string; at: string }[];
  // True once the "updated" notice was printed for `installed`.
  notified: boolean;
  // Agent files a refresh left alone because the developer edited them.
  kept: string[];
  // When every candidate last failed because the built-in trust data no
  // longer recognises the signer, and when that was last said.
  trustFailedAt: string | null;
  trustNoticeAt: string | null;
  // Written just before an activation switches the pointer and cleared once
  // its bookkeeping is saved; a later worker or rollback finishes or clears it.
  activation: { from: string; to: string } | null;
  // The sha256 of a config.yaml that `update` created, so uninstall removes
  // it only while it is unchanged.
  userConfig: string | null;
};

export function emptyState(): UpdateState {
  return {
    checkedAt: null,
    latestSeen: null,
    latestSeenAt: null,
    installed: null,
    previous: null,
    lastError: null,
    skipped: [],
    notified: true,
    kept: [],
    trustFailedAt: null,
    trustNoticeAt: null,
    activation: null,
    userConfig: null,
  };
}

export function statePath(home: string): string {
  return join(home, "update.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function readState(home: string): UpdateState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(statePath(home)) ?? "null");
  } catch {
    return emptyState();
  }
  if (!isObject(parsed)) return emptyState();
  const skipped = Array.isArray(parsed.skipped)
    ? parsed.skipped.filter(isObject).flatMap((s) =>
        typeof s.version === "string" && typeof s.reason === "string" && typeof s.at === "string" ? [{ version: s.version, reason: s.reason, at: s.at }] : [],
      )
    : [];
  return {
    checkedAt: str(parsed.checkedAt),
    latestSeen: str(parsed.latestSeen),
    latestSeenAt: str(parsed.latestSeenAt),
    installed: str(parsed.installed),
    previous: str(parsed.previous),
    lastError: str(parsed.lastError),
    skipped,
    notified: parsed.notified !== false,
    kept: Array.isArray(parsed.kept) ? parsed.kept.filter((k): k is string => typeof k === "string") : [],
    trustFailedAt: str(parsed.trustFailedAt),
    trustNoticeAt: str(parsed.trustNoticeAt),
    activation:
      isObject(parsed.activation) && typeof parsed.activation.from === "string" && typeof parsed.activation.to === "string"
        ? { from: parsed.activation.from, to: parsed.activation.to }
        : null,
    userConfig: str(parsed.userConfig),
  };
}

function write(home: string, change: Partial<UpdateState> | ((s: UpdateState) => Partial<UpdateState>)): UpdateState {
  const before = readState(home);
  const next = { ...before, ...(typeof change === "function" ? change(before) : change) };
  writeAtomic(statePath(home), `${JSON.stringify(next, null, 2)}\n`, 0o600);
  return next;
}

function stateLock(home: string): string {
  return join(home, "update.json.lock");
}

// Reads, changes and writes the state in one step under update.json.lock, so
// two processes never lose each other's writes: a temp file then a rename,
// private to the user. `change` may be a function of the state as read
// under the lock.
export function updateState(home: string, change: Partial<UpdateState> | ((s: UpdateState) => Partial<UpdateState>)): UpdateState {
  const held = waitLockSync(stateLock(home), 5_000, `${statePath(home)} is busy`);
  try {
    return write(home, change);
  } finally {
    held.release();
  }
}

// The same, but only when the lock is free right now; null otherwise. For a
// command's notice, which must never delay its exit.
export function tryUpdateState(home: string, change: (s: UpdateState) => Partial<UpdateState> | null): UpdateState | null {
  const held = takeLock(stateLock(home));
  if (held === null) return null;
  try {
    const wanted = change(readState(home));
    return wanted === null ? null : write(home, wanted);
  } finally {
    held.release();
  }
}

// ---------- the user-level config, <home>/config.yaml ----------

export function userConfigPath(home: string): string {
  return join(home, "config.yaml");
}

type UserConfig = { ok: true; update: "on" | "off" | null; raw: string | null } | { ok: false; reason: string };

function readUserConfig(home: string): UserConfig {
  let raw: string | null;
  try {
    raw = readText(userConfigPath(home));
  } catch {
    return { ok: false, reason: `${userConfigPath(home)} cannot be read` };
  }
  if (raw === null) return { ok: true, update: null, raw };
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) return { ok: false, reason: `${userConfigPath(home)} does not parse` };
  const data: unknown = doc.toJS();
  if (data === null || data === undefined) return { ok: true, update: null, raw };
  if (!isObject(data)) return { ok: false, reason: `${userConfigPath(home)} is not a mapping` };
  const value = data.update;
  if (value === undefined) return { ok: true, update: null, raw };
  if (value === "on" || value === true) return { ok: true, update: "on", raw };
  if (value === "off" || value === false) return { ok: true, update: "off", raw };
  return { ok: false, reason: `update in ${userConfigPath(home)} is neither on nor off` };
}

// Whether a worker may check and install now, and the reason when not.
export function updatesAllowed(home: string, env: NodeJS.ProcessEnv): { allowed: boolean; why: string } {
  if (env.CI !== undefined && env.CI !== "") return { allowed: false, why: "off: CI is set" };
  if (env.OPENQODEX_OFFLINE === "1") return { allowed: false, why: "off: offline (--offline or OPENQODEX_OFFLINE=1)" };
  if (env.OPENQODEX_AUTO_UPDATE === "0") return { allowed: false, why: "off: OPENQODEX_AUTO_UPDATE=0" };
  const config = readUserConfig(home);
  if (!config.ok) return { allowed: false, why: `off: ${config.reason}` };
  if (config.update === "off") return { allowed: false, why: `off: update: off in ${userConfigPath(home)}` };
  return { allowed: true, why: "on" };
}

// Sets `update:` in the user config, keeping every other key and comment.
// Refuses a config that does not parse rather than overwrite it. A file this
// created, and changed only by this since, is remembered in update.json so
// uninstall removes it; a file the developer wrote is never remembered.
export function setUserUpdate(home: string, value: "on" | "off"): void {
  const config = readUserConfig(home);
  if (!config.ok) throw new Error(`${config.reason}; fix or remove it first`);
  const ours = config.raw === null || readState(home).userConfig === sha256(config.raw);
  const doc = parseDocument(config.raw ?? "");
  let text: string;
  if (doc.contents === null) text = `update: ${value}\n`;
  else {
    doc.set("update", value);
    text = String(doc);
  }
  writeAtomic(userConfigPath(home), text);
  if (ours) updateState(home, { userConfig: sha256(text) });
}
