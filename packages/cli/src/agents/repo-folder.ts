// The repo folder `.openqodex/`: its two team files (config.yaml and
// custom-instructions.md, meant to be committed) and its .gitignore. Created
// by init and by the first scan or review in a repo; an existing file is
// never touched. Init records what it created, and uninstall removes a file
// only while it is unchanged and not committed.
import { readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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

function repoFiles(repoRoot: string): { files: RepoFile[]; gitignore: RepoFile; rootConfig: boolean } {
  const dir = join(repoRoot, STATE_DIR);
  const rootConfig = readText(join(repoRoot, ".openqodex.yaml")) !== null;
  const files: RepoFile[] = [];
  if (!rootConfig) files.push({ path: join(dir, FOLDER_CONFIG), label: "the team's OpenQodex config, to commit", text: DEFAULT_CONFIG_YAML });
  files.push({ path: join(dir, INSTRUCTIONS_FILE), label: "what a reviewer of this repo must know, to commit", text: instructionsTemplate() });
  return { files, gitignore: { path: join(dir, ".gitignore"), label: "keeps the review reports out of git", text: STATE_GITIGNORE }, rootConfig };
}

function remember(record: InstallRecord, f: RepoFile): void {
  if (readText(f.path) !== f.text) return;
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
    // The Day 0 folder ignored itself with "*": rewritten once.
    const day0 = f === gitignore && before === "*\n";
    if (before !== null && !day0) {
      actions.push({ verb: "skip", path: f.path, note: f === gitignore ? "already there" : "already there; never changed by openqodex" });
      continue;
    }
    actions.push({
      verb: day0 ? "update" : "create",
      path: f.path,
      note: f.label,
      guard: { path: f.path, before },
      apply: () => {
        writeAtomic(f.path, f.text);
        remember(record, f);
      },
    });
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
