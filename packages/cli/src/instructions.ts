// The repo owners' instructions for the review, from
// `.openqodex/custom-instructions.md`. Handed to the brief whole: a file over
// the limit is refused, never cut, since an instruction after a cut would
// vanish without a trace.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { OpenQodexError, STATE_DIR, isRepoState, readFileBounded, readRepoFile } from "@openqodex/core";

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
