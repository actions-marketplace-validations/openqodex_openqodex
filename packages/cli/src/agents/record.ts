// The installation record, <openqodex home>/install.json: what `init` and
// `hook install` wrote, so a later run changes or removes only what is still
// exactly as we wrote it. A developer's edit makes a thing theirs.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorCode, readText, writeAtomic } from "./files.js";

export type InstallRecord = {
  version: 1;
  // Whole files we created or replaced: skills, rules, the launcher, git hooks.
  files: { path: string; sha256: string; usesLauncher: boolean }[];
  // Hook groups merged into a JSON settings file, exactly as inserted.
  hooks: { path: string; entry: unknown; createdFile: boolean; usesLauncher: boolean }[];
  // Markdown sections between the openqodex markers, exactly as written.
  sections: { path: string; text: string; createdFile: boolean }[];
  // Lines we added to an exclude file; `repo` is the work tree that needs it.
  excludes: { file: string; line: string; repo: string }[];
  // Copies of files as they were before we changed them.
  backups: { path: string; of: string }[];
  // Runtime folders we created.
  runtimes: string[];
};

export function emptyRecord(): InstallRecord {
  return { version: 1, files: [], hooks: [], sections: [], excludes: [], backups: [], runtimes: [] };
}

export function recordPath(home: string): string {
  return join(home, "install.json");
}

export function loadRecord(home: string): InstallRecord {
  const text = readText(recordPath(home));
  if (text === null) return emptyRecord();
  let parsed: Partial<InstallRecord>;
  try {
    parsed = JSON.parse(text) as Partial<InstallRecord>;
  } catch {
    throw new Error(`${recordPath(home)} does not parse; move it aside and run again`);
  }
  return { ...emptyRecord(), ...parsed, version: 1 };
}

export function isEmpty(record: InstallRecord): boolean {
  return (
    record.files.length + record.hooks.length + record.sections.length + record.excludes.length + record.backups.length + record.runtimes.length ===
    0
  );
}

// Writes the record when it changed; removes it when nothing is recorded.
export function saveRecord(home: string, record: InstallRecord, before: string): void {
  const next = `${JSON.stringify(record, null, 2)}\n`;
  if (next === before) return;
  if (isEmpty(record)) rmSync(recordPath(home), { force: true });
  else writeAtomic(recordPath(home), next, 0o600);
}

export function serialize(record: InstallRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

// JSON with object keys sorted, so equal values compare equal.
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// One `init` or `hook install` at a time per home folder. A lock left by a
// process that is gone is taken over.
export async function withLock<T>(home: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(home, { recursive: true });
  const lock = join(home, "install.lock");
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let holder = 0;
      try {
        holder = Number(readFileSync(lock, "utf8").trim());
      } catch {
        // removed between the two calls
      }
      if (holder > 0 && !alive(holder)) rmSync(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`another openqodex init is running (lock ${lock})`);
      else await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
