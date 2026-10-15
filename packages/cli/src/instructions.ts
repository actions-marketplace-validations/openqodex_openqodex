// The repo owners' instructions for the review, from
// `.openqodex/custom-instructions.md`. Handed to the brief whole: a file over
// the limit is refused, never cut, since an instruction after a cut would
// vanish without a trace.
import { isSeq, parseDocument } from "yaml";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { FolderReader, OpenQodexError, STATE_DIR, isRepoState, isShippedInstructionFile, readFileBounded, readRepoFile, stripInstructionSections } from "@openqodex/core";

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

// Bounded reads distinguish real conventions from sections init wrote.
// The list shows metadata only. init asks before selecting anything.
export function instructionCandidates(repoRoot: string): { path: string; bytes: number }[] {
  const reader = new FolderReader(repoRoot);
  const found: { path: string; bytes: number }[] = [];
  const add = (path: string): void => {
    const entry = reader.entry(path.split("/"));
    if (!entry.ok || !entry.stat.isFile()) return;
    const content = reader.read(path.split("/"), INSTRUCTIONS_MAX_BYTES);
    // A large or unreadable candidate remains visible so the owner can decide.
    if (content.ok) {
      const text = content.data.toString("utf8");
      if (isShippedInstructionFile(text) || stripInstructionSections(text).trim() === "") return;
    }
    found.push({ path, bytes: Number(entry.stat.size) });
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

export function conventionHint(repoRoot: string, paths: readonly string[] = []): string | null {
  if (paths.length > 0) return null;
  const candidates = instructionCandidates(repoRoot);
  return candidates.length === 0 ? null : `Convention files available: ${candidates.map((file) => file.path).join(", ")}. Ask the developer which files to set in review.instructions_files.`;
}

// Keep precedence when a picker changes only part of an explicit list.
export function mergeInstructionChoice(previous: readonly string[], candidates: readonly string[], chosen: readonly string[]): string[] {
  return [
    ...previous.filter((path) => !candidates.includes(path) || chosen.includes(path)),
    ...chosen.filter((path) => !previous.includes(path)),
  ];
}

// Keep the hosted block spelling and the nodes that carry comments or anchors.
export function writeInstructionChoice(before: string, paths: readonly string[]): string {
  const document = parseDocument(before);
  const block = document.has("pr_review") && !document.has("review") ? "pr_review" : "review";
  const key = [block, "instructions_files"];
  const sequence = document.getIn(key, true);
  if (isSeq(sequence)) {
    const previous = document.toJS()[block].instructions_files as string[];
    sequence.items = sequence.items.filter((_, index) => paths.includes(previous[index]!));
    for (const path of paths) if (!previous.includes(path)) sequence.add(document.createNode(path));
  } else document.setIn(key, document.createNode(paths));
  return document.toString();
}
