// The repo folder `.openqodex/`: its two team files (config.yaml and
// custom-instructions.md, meant to be committed) and its .gitignore. Created
// by init and by the first scan or review in a repo; an existing file is
// never touched. Init records what it created, and uninstall removes a file
// only while it is unchanged and not committed.
import { mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG_YAML, FOLDER_CONFIG, INSTRUCTIONS_FILE, STATE_DIR, STATE_GITIGNORE, ensureRepoFiles, type RepoFiles } from "@openqodex/core";
import { assetPath } from "../assets.js";
import { assertNoSymlinkInRepo, readText, sha256, writeAtomic } from "./files.js";
import { isTracked } from "./git.js";
import { ownedFile, type Action } from "./plan.js";
import type { InstallRecord } from "./record.js";

export function instructionsTemplate(): string {
  return readFileSync(assetPath("templates", "repo", "custom-instructions.md"), "utf8");
}

export function createRepoFiles(repoRoot: string): RepoFiles {
  return ensureRepoFiles(repoRoot, { config: DEFAULT_CONFIG_YAML, instructions: instructionsTemplate() });
}

export const INSTRUCTIONS_LINE =
  "Write in .openqodex/custom-instructions.md what a reviewer of this repo must know: conventions, what never to flag, what always to check.";

export const ROOT_CONFIG_NOTE =
  "This repo has .openqodex.yaml at its root; it is still read. To move it into the folder: git mv .openqodex.yaml .openqodex/config.yaml";

// What a scan or review tells the developer about files it just created.
export function repoFilesLines(files: RepoFiles): string[] {
  if (files.created.length === 0) return [];
  const them = files.created.length > 1 ? "them" : "it";
  return [
    `Created ${files.created.join(" and ")}. Commit ${them} so your team shares ${them}.`,
    ...(files.created.some((p) => p.endsWith(INSTRUCTIONS_FILE)) ? [INSTRUCTIONS_LINE] : []),
    ...(files.rootConfig ? [ROOT_CONFIG_NOTE] : []),
  ];
}

type RepoFile = { path: string; label: string; text: string };

// What the folder's .gitignore held on Day 0: the whole folder ignored itself.
const DAY0_GITIGNORE = "*\n";

function repoFiles(repoRoot: string): { files: RepoFile[]; gitignore: RepoFile; rootConfig: boolean } {
  const dir = join(repoRoot, STATE_DIR);
  const rootConfig = readText(join(repoRoot, ".openqodex.yaml")) !== null;
  const files: RepoFile[] = [];
  if (!rootConfig) files.push({ path: join(dir, FOLDER_CONFIG), label: "the team's OpenQodex config, to commit", text: DEFAULT_CONFIG_YAML });
  files.push({ path: join(dir, INSTRUCTIONS_FILE), label: "what a reviewer of this repo must know, to commit", text: instructionsTemplate() });
  return { files, gitignore: { path: join(dir, ".gitignore"), label: "keeps the review reports out of git", text: STATE_GITIGNORE }, rootConfig };
}

// Creates the file only when nothing is there (an exclusive open, never a
// replacing rename), and records it as ours only when that create succeeded:
// a first scan running at the same moment keeps its own file.
function createOwned(record: InstallRecord, f: RepoFile): void {
  mkdirSync(dirname(f.path), { recursive: true });
  try {
    writeFileSync(f.path, f.text, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  record.files = record.files.filter((r) => r.path !== f.path);
  record.files.push({ path: f.path, sha256: sha256(f.text), usesLauncher: false });
}

export function planRepoFiles(repoRoot: string, record: InstallRecord): { actions: Action[]; rootConfig: boolean } {
  const { files, gitignore, rootConfig } = repoFiles(repoRoot);
  const actions: Action[] = [];
  // The .gitignore first, so the reports never show in git status.
  const all = [gitignore, ...files];
  for (const f of all) {
    assertNoSymlinkInRepo(repoRoot, f.path);
    const before = readText(f.path);
    // The Day 0 folder ignored itself with "*": rewritten once, recorded as a
    // migration with the original bytes, so uninstall puts them back.
    if (f === gitignore && before === DAY0_GITIGNORE) {
      actions.push({
        verb: "update",
        path: f.path,
        note: `${f.label}, in place of the old "*"`,
        guard: { path: f.path, before },
        apply: () => {
          writeAtomic(f.path, f.text);
          record.migrations = record.migrations.filter((m) => m.path !== f.path);
          record.migrations.push({ path: f.path, original: before, sha256: sha256(f.text) });
        },
      });
      continue;
    }
    if (before !== null) {
      actions.push({ verb: "skip", path: f.path, note: f === gitignore ? "already there" : "already there; never changed by openqodex" });
      continue;
    }
    actions.push({ verb: "create", path: f.path, note: f.label, guard: { path: f.path, before }, apply: () => createOwned(record, f) });
  }
  return { actions, rootConfig };
}

// Removes what init created there while it is unchanged and not committed;
// the .gitignore and the folder go only when nothing else is left in it.
export async function planRepoFilesRemoval(repoRoot: string, record: InstallRecord): Promise<Action[]> {
  const dir = join(repoRoot, STATE_DIR);
  const { files, gitignore } = repoFiles(repoRoot);
  const actions: Action[] = [];
  const removing = new Set<string>();
  const forget = (path: string): void => {
    record.files = record.files.filter((r) => r.path !== path);
  };
  const consider = async (f: RepoFile): Promise<void> => {
    if (!record.files.some((r) => r.path === f.path)) return;
    assertNoSymlinkInRepo(repoRoot, f.path);
    const before = readText(f.path);
    if (before === null) return forget(f.path);
    if (!ownedFile(record, f.path, before)) {
      forget(f.path);
      actions.push({ verb: "keep", path: f.path, note: "edited after init; left in place" });
      return;
    }
    if (await isTracked(repoRoot, f.path)) {
      forget(f.path);
      actions.push({ verb: "keep", path: f.path, note: "committed to the repo; left in place" });
      return;
    }
    removing.add(f.path);
    actions.push({
      verb: "remove",
      path: f.path,
      note: f.label,
      guard: { path: f.path, before },
      apply: () => {
        rmSync(f.path, { force: true });
        forget(f.path);
      },
    });
  };
  for (const f of files) await consider(f);
  // A migrated Day 0 .gitignore gets its original bytes back while it is
  // still what init wrote.
  const migration = record.migrations.find((m) => m.path === gitignore.path);
  if (migration) {
    record.migrations = record.migrations.filter((m) => m !== migration);
    const now = readText(gitignore.path);
    if (now !== null && sha256(now) === migration.sha256) {
      actions.push({
        verb: "restore",
        path: gitignore.path,
        note: "the .gitignore as it was before init",
        guard: { path: gitignore.path, before: now },
        apply: () => writeAtomic(gitignore.path, migration.original),
      });
    }
    return actions;
  }
  let others: string[] = [];
  try {
    others = readdirSync(dir).filter((n) => !removing.has(join(dir, n)) && join(dir, n) !== gitignore.path);
  } catch {
    // no folder
  }
  if (others.length === 0) {
    await consider(gitignore);
    const last = actions[actions.length - 1];
    if (last?.path === gitignore.path && last.verb === "remove") {
      const inner = last.apply!;
      last.apply = () => {
        inner();
        try {
          rmdirSync(dir);
        } catch {
          // something else is there now; it is not ours
        }
      };
    }
  } else if (record.files.some((r) => r.path === gitignore.path)) {
    // The reports are still there and need it; it stops being ours.
    forget(gitignore.path);
  }
  return actions;
}

// The first scan or review in a repo creates the two team files and says so
// on stderr, one line each.
export function announceRepoFiles(repoRoot: string): void {
  for (const line of repoFilesLines(createRepoFiles(repoRoot))) process.stderr.write(`openqodex: ${line}\n`);
}
