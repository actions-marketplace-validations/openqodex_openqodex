// Turns targets into a list of actions, each with what it will do and how,
// so `init` prints the full plan before it writes anything.
import { existsSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { basename, dirname } from "node:path";
import { readText, hasMarker, writeAtomic } from "./files.js";
import type { HookGroup, HookHandler, Target } from "./targets.js";
import { SECTION_END, SECTION_START } from "./targets.js";

export type Verb = "create" | "update" | "merge" | "append" | "replace" | "remove" | "restore" | "skip" | "refuse";

export type Action = {
  verb: Verb;
  path: string;
  note: string;
  // Set when the file could not be handled; init exits 2 after the rest.
  failed?: boolean;
  // Absent for "skip" and "refuse".
  apply?: () => void | Promise<void>;
};

export const BACKUP_SUFFIX = ".openqodex.bak";

// A hook command that `init` wrote, from any version: the launcher or npx
// form, followed by `hook check`.
export function isOurHookCommand(command: unknown): boolean {
  return typeof command === "string" && /(^|[/'"\s])openqodex(@\S+)?'?\s+hook\s+check(\s|$)/.test(command);
}

type Settings = { hooks?: { PreToolUse?: HookGroup[]; [k: string]: unknown }; [k: string]: unknown };

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Parses a settings file and checks the parts we touch have the shape the
// agent expects. Returns a reason string when the file must be left alone.
function parseSettings(text: string): Settings | string {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return "does not parse as JSON";
  }
  if (!isObject(data)) return "is not a JSON object";
  if (data.hooks !== undefined) {
    if (!isObject(data.hooks)) return '"hooks" is not an object';
    const pre = data.hooks.PreToolUse;
    if (pre !== undefined && !Array.isArray(pre)) return '"hooks.PreToolUse" is not a list';
  }
  return data as Settings;
}

// Removes every handler of ours; drops groups, lists and objects that end
// up empty because of it. Returns how many handlers were removed.
function removeOurHandlers(data: Settings): number {
  const pre = data.hooks?.PreToolUse;
  if (!pre) return 0;
  let removed = 0;
  const kept: HookGroup[] = [];
  for (const group of pre) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = (group.hooks as HookHandler[]).filter((h) => !(isObject(h) && isOurHookCommand(h.command)));
    removed += group.hooks.length - handlers.length;
    if (handlers.length === group.hooks.length) kept.push(group);
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  if (removed === 0) return 0;
  if (kept.length > 0) data.hooks!.PreToolUse = kept;
  else delete data.hooks!.PreToolUse;
  if (Object.keys(data.hooks!).length === 0) delete data.hooks;
  return removed;
}

function ourCommands(data: Settings): string[] {
  const out: string[] = [];
  for (const group of data.hooks?.PreToolUse ?? []) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    for (const h of group.hooks as unknown[]) if (isObject(h) && isOurHookCommand(h.command)) out.push(h.command as string);
  }
  return out;
}

export function hasOurHook(path: string): boolean {
  const text = readText(path);
  if (text === null) return false;
  const data = parseSettings(text);
  return typeof data !== "string" && ourCommands(data).length > 0;
}

function saveBackupOnce(path: string, text: string): void {
  if (!existsSync(path + BACKUP_SUFFIX)) writeAtomic(path + BACKUP_SUFFIX, text);
}

// Removes the file, then its folder when the folder is named openqodex and
// is left empty (the skill folder).
function removeFile(path: string): void {
  rmSync(path, { force: true });
  const dir = dirname(path);
  if (basename(dir) === "openqodex" && readdirSync(dir).length === 0) rmdirSync(dir);
}

function sectionBounds(text: string): { start: number; end: number } | null {
  const start = text.indexOf(SECTION_START);
  if (start === -1) return null;
  const endAt = text.indexOf(SECTION_END, start);
  if (endAt === -1) return null;
  return { start, end: endAt + SECTION_END.length };
}

export function planInstall(t: Target): Action {
  const text = readText(t.path);
  switch (t.kind) {
    case "file": {
      if (text === null) return { verb: "create", path: t.path, note: t.label, apply: () => writeAtomic(t.path, t.content) };
      if (text === t.content || text === t.plain) return { verb: "skip", path: t.path, note: `${t.label} already present` };
      if (hasMarker(text)) return { verb: "update", path: t.path, note: t.label, apply: () => writeAtomic(t.path, t.content) };
      return { verb: "refuse", path: t.path, note: `${t.label}: the file exists with other content and is left alone` };
    }
    case "hook-json": {
      if (text === null) {
        return {
          verb: "create",
          path: t.path,
          note: t.label,
          apply: () => writeAtomic(t.path, json({ hooks: { PreToolUse: [t.group] } })),
        };
      }
      const data = parseSettings(text);
      if (typeof data === "string") {
        return { verb: "refuse", path: t.path, note: `${t.label}: the file ${data}; left untouched, fix it and run init again`, failed: true };
      }
      const ours = ourCommands(data);
      if (ours.length === 1 && ours[0] === t.command) return { verb: "skip", path: t.path, note: `${t.label} already present` };
      const verb: Verb = ours.length > 0 ? "update" : "merge";
      removeOurHandlers(data);
      data.hooks ??= {};
      data.hooks.PreToolUse = [...(data.hooks.PreToolUse ?? []), t.group];
      return {
        verb,
        path: t.path,
        note: `${t.label}, other settings kept (previous file saved as ${basename(t.path)}${BACKUP_SUFFIX})`,
        apply: () => {
          saveBackupOnce(t.path, text);
          writeAtomic(t.path, json(data));
        },
      };
    }
    case "md-section": {
      const section = `${t.section}\n`;
      if (text === null) return { verb: "create", path: t.path, note: t.label, apply: () => writeAtomic(t.path, section) };
      const at = sectionBounds(text);
      if (at === null) {
        const joined = text === "" ? section : `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${section}`;
        return { verb: "append", path: t.path, note: `${t.label} section`, apply: () => writeAtomic(t.path, joined) };
      }
      if (text.slice(at.start, at.end) === t.section) return { verb: "skip", path: t.path, note: `${t.label} section already present` };
      const replaced = text.slice(0, at.start) + t.section + text.slice(at.end);
      return { verb: "replace", path: t.path, note: `${t.label} section`, apply: () => writeAtomic(t.path, replaced) };
    }
  }
}

// Null when there is nothing of ours to remove.
export function planUninstall(t: Target): Action | null {
  const text = readText(t.path);
  if (text === null) return null;
  switch (t.kind) {
    case "file": {
      if (text === t.content) return { verb: "remove", path: t.path, note: t.label, apply: () => removeFile(t.path) };
      if (hasMarker(text)) return { verb: "skip", path: t.path, note: `${t.label} was changed after init; left in place` };
      return null;
    }
    case "hook-json": {
      const data = parseSettings(text);
      if (typeof data === "string") return { verb: "refuse", path: t.path, note: `${t.label}: the file ${data}; left untouched`, failed: true };
      if (removeOurHandlers(data) === 0) return null;
      const backup = readText(t.path + BACKUP_SUFFIX);
      if (backup !== null && json(data) === json(parseSettings(backup))) {
        return {
          verb: "restore",
          path: t.path,
          note: `${t.label} removed, the file put back as it was before init`,
          apply: () => renameSync(t.path + BACKUP_SUFFIX, t.path),
        };
      }
      if (backup === null && Object.keys(data).length === 0) {
        return { verb: "remove", path: t.path, note: `${t.label} (init created this file)`, apply: () => removeFile(t.path) };
      }
      return { verb: "update", path: t.path, note: `${t.label} removed, other settings kept`, apply: () => writeAtomic(t.path, json(data)) };
    }
    case "md-section": {
      const at = sectionBounds(text);
      if (at === null) return null;
      let before = text.slice(0, at.start);
      let after = text.slice(at.end);
      if (after.startsWith("\n")) after = after.slice(1);
      if (after === "" && before.endsWith("\n\n")) before = before.slice(0, -1);
      const rest = before + after;
      if (rest.trim() === "") return { verb: "remove", path: t.path, note: `${t.label} (only our section was in it)`, apply: () => removeFile(t.path) };
      return { verb: "update", path: t.path, note: `${t.label} section removed`, apply: () => writeAtomic(t.path, rest) };
    }
  }
}
