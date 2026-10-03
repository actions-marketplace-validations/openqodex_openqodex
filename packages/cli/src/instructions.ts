// The repo owners' instructions for the review, from
// `.openqodex/custom-instructions.md`. Handed to the brief whole: a file over
// the limit is refused, never cut, since an instruction after a cut would
// vanish without a trace.
import { join } from "node:path";
import { STATE_DIR, readRepoFile } from "@openqodex/core";

export const INSTRUCTIONS_FILE = "custom-instructions.md";
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

// The file's text, or "" when there is none. Never read through a link.
export function readInstructions(repoRoot: string): string {
  return (
    readRepoFile(repoRoot, join(STATE_DIR, INSTRUCTIONS_FILE), INSTRUCTIONS_MAX_BYTES, "; shorten it so every instruction reaches the review") ?? ""
  );
}
