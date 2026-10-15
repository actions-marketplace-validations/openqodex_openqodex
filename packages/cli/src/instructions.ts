// The repo owners' instructions for the review, from
// `.openqodex/custom-instructions.md`. Handed to the brief whole: a file over
// the limit is refused, never cut, since an instruction after a cut would
// vanish without a trace.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { FolderReader, OpenQodexError, STATE_DIR, isRepoState, readFileBounded, readRepoFile } from "@openqodex/core";

export const INSTRUCTIONS_FILE = "custom-instructions.md";
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;
const TOO_BIG_HINT = "; shorten it so every instruction reaches the review";

// The file's text, or "" when there is none. Never read through a link.
export function readInstructions(repoRoot: string): string {
  return readRepoFile(repoRoot, join(STATE_DIR, INSTRUCTIONS_FILE), INSTRUCTIONS_MAX_BYTES, TOO_BIG_HINT) ?? "";
}

// The file `review --instructions` names, read the way `--config` reads its
// file: a path relative to the repo root; a file in the repo state is read as
// repo state, never through a link; any other file may be reached through a
// link but must be a regular file within the same limit. An empty file means
// no instructions; a missing one stops the review.
export function readInstructionsAt(repoRoot: string, explicitPath: string): string {
  const path = isAbsolute(explicitPath) ? explicitPath : resolve(repoRoot, explicitPath);
  const state = isRepoState(repoRoot, path);
  if (state !== null) {
    const text = readRepoFile(repoRoot, state, INSTRUCTIONS_MAX_BYTES, TOO_BIG_HINT);
    if (text === null) throw new OpenQodexError(`instructions file not found: ${path}`);
    return text;
  }
  if (!existsSync(path)) throw new OpenQodexError(`instructions file not found: ${path}`);
  return readFileBounded(path, INSTRUCTIONS_MAX_BYTES, TOO_BIG_HINT);
}

// Only metadata is listed here. init asks the developer before selecting it.
export function instructionCandidates(repoRoot: string): { path: string; bytes: number }[] {
  const reader = new FolderReader(repoRoot);
  const found: { path: string; bytes: number }[] = [];
  const add = (path: string): void => {
    const entry = reader.entry(path.split("/"));
    if (entry.ok && entry.stat.isFile()) found.push({ path, bytes: Number(entry.stat.size) });
  };
  for (const path of ["CONTRIBUTING.md", "CLAUDE.md", "AGENTS.md", ".cursorrules"]) add(path);
  const walk = (parts: string[]): void => {
    for (const name of reader.list(parts)?.names.sort() ?? []) {
      const names = [...parts, name];
      const entry = reader.entry(names);
      if (entry.ok && entry.stat.isDirectory()) walk(names);
      else add(names.join("/"));
    }
  };
  walk([".cursor", "rules"]);
  add(".github/copilot-instructions.md");
  return found;
}

export function conventionHint(repoRoot: string, paths: readonly string[]): string | null {
  if (paths.length > 0) return null;
  const candidates = instructionCandidates(repoRoot);
  return candidates.length === 0 ? null : `Convention files available: ${candidates.map((file) => file.path).join(", ")}. Ask the developer which files to set in review.instructions_files.`;
}
