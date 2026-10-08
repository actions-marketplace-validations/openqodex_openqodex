// The self-update's state, <home>/update.json: a cache for the status lines
// and the notices, never read for a safety decision. Each write is a temp
// file then a rename; when two processes write at once the last one wins,
// and the worst a lost write costs is one extra check or one missed notice.
// Unreadable state reads as empty. The switch is the user config file
// below, and it fails safe: a config that cannot be used, a value that is
// not understood or a key this version does not know turns updating off.
import { join } from "node:path";
import { parseDocument } from "yaml";
import { readText, sha256 } from "../agents/files.js";
import { homeGuard } from "../agents/guarded-fs.js";
import { asMapping, readUserConfig, unknownKeys, userConfigPath } from "../user-config.js";

export { userConfigPath } from "../user-config.js";

export type UpdateState = {
  // When a worker last started a check (ISO time); the trigger waits 24 hours after it.
  checkedAt: string | null;
  // The registry's latest version at the last check that reached it.
  latestSeen: string | null;
  // Releases that failed verification or could not be activated, with when.
  skipped: { version: string; reason: string; at: string }[];
  lastError: string | null;
  // One line for the next command run by `version` to print, then cleared.
  notice: { version: string; text: string } | null;
  // The sha256 of a config.yaml that `update` created, so uninstall removes
  // it only while it is unchanged.
  userConfig: string | null;
};

export function emptyState(): UpdateState {
  return { checkedAt: null, latestSeen: null, skipped: [], lastError: null, notice: null, userConfig: null };
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
  const n = parsed.notice;
  return {
    checkedAt: str(parsed.checkedAt),
    latestSeen: str(parsed.latestSeen),
    skipped,
    lastError: str(parsed.lastError),
    notice: isObject(n) && typeof n.version === "string" && typeof n.text === "string" ? { version: n.version, text: n.text } : null,
    userConfig: str(parsed.userConfig),
  };
}

// Reads, changes and writes the state. Not locked: see the top of this file.
export function updateState(home: string, change: Partial<UpdateState>): void {
  homeGuard(home).write(statePath(home), `${JSON.stringify({ ...readState(home), ...change }, null, 2)}\n`, { mode: 0o600 });
}

// ---------- the update keys of the user config (user-config.ts) ----------

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// What the user config says about updating: `update` and `skip_version`, or
// why the file stops automatic updates: it cannot be used or a value is not
// understood (off), or it holds a key this version does not know (paused).
type Switch = { ok: true; update: "on" | "off" | null; skip: string | null } | { ok: false; why: string };

function readSwitch(home: string): Switch {
  const config = readUserConfig(home);
  if (config.error !== null) return { ok: false, why: `off: ${config.error}` };
  const value = config.values.update;
  let update: "on" | "off" | null = null;
  if (value === "on" || value === true) update = "on";
  else if (value === "off" || value === false) update = "off";
  else if (value !== undefined && value !== null) return { ok: false, why: `off: update in ${config.path} is neither on nor off` };
  if (update === "off") return { ok: true, update, skip: null };
  const skip = config.values.skip_version;
  if (skip !== undefined && skip !== null && !(typeof skip === "string" && PLAIN_VERSION.test(skip))) {
    return { ok: false, why: `off: skip_version in ${config.path} is not a version such as 0.9.0` };
  }
  // A key this version does not know may be a misspelled `update: off`, or
  // a setting of a newer version this one cannot honour.
  const unknown = unknownKeys(config);
  if (unknown !== null) return { ok: false, why: `paused: ${unknown}; fix it and automatic updates resume` };
  return { ok: true, update, skip: typeof skip === "string" ? skip : null };
}

// Whether a worker may check and install now, and the reason when not.
export function updatesAllowed(home: string, env: NodeJS.ProcessEnv): { allowed: boolean; why: string } {
  if (env.CI !== undefined && env.CI !== "") return { allowed: false, why: "off: CI is set" };
  if (env.OPENQODEX_OFFLINE === "1") return { allowed: false, why: "off: offline (--offline or OPENQODEX_OFFLINE=1)" };
  if (env.OPENQODEX_AUTO_UPDATE === "0") return { allowed: false, why: "off: OPENQODEX_AUTO_UPDATE=0" };
  const config = readSwitch(home);
  if (!config.ok) return { allowed: false, why: config.why };
  if (config.update === "off") return { allowed: false, why: `off: update: off in ${userConfigPath(home)}` };
  return { allowed: true, why: "on" };
}

// The release `update --rollback` left: the worker installs neither it nor
// any older one. Null when none is set or the file cannot be used.
export function skipVersion(home: string): string | null {
  const config = readSwitch(home);
  return config.ok ? config.skip : null;
}

// Sets keys of the user config, keeping every other key and every comment,
// a file of comments only included. Refuses a file that cannot be used
// rather than overwrite it. A file this created, and changed only by this
// since, is remembered in update.json so uninstall removes it; a file the
// developer wrote is never remembered.
export function setUserKeys(home: string, set: { update?: "on" | "off"; skip_version?: string }): void {
  const config = readUserConfig(home);
  if (config.error !== null) throw new Error(`${config.error}; fix or remove it first`);
  const ours = config.raw === null || readState(home).userConfig === sha256(config.raw);
  const doc = parseDocument(config.raw ?? "");
  asMapping(doc);
  for (const [key, value] of Object.entries(set)) doc.set(key, value);
  const text = String(doc);
  homeGuard(home).write(userConfigPath(home), text);
  if (ours) updateState(home, { userConfig: sha256(text) });
}

export function setUserUpdate(home: string, value: "on" | "off"): void {
  setUserKeys(home, { update: value });
}
