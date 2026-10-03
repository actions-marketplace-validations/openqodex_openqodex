// The repo owners' instructions for the review, from
// `.openqodex/custom-instructions.md`. Handed to the brief whole: a file over
// the limit is refused, never cut, since an instruction after a cut would
// vanish without a trace.
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenQodexError, STATE_DIR } from "@openqodex/core";

export const INSTRUCTIONS_FILE = "custom-instructions.md";
export const INSTRUCTIONS_MAX_BYTES = 32 * 1024;

// The file's text, or "" when there is none. Opened without following a link.
export function readInstructions(repoRoot: string): string {
  const path = join(repoRoot, STATE_DIR, INSTRUCTIONS_FILE);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new OpenQodexError(`${STATE_DIR}/${INSTRUCTIONS_FILE} cannot be read: ${(error as Error).message}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new OpenQodexError(`${STATE_DIR}/${INSTRUCTIONS_FILE} is not a regular file`);
    if (st.size > INSTRUCTIONS_MAX_BYTES) {
      throw new OpenQodexError(
        `${STATE_DIR}/${INSTRUCTIONS_FILE} is ${Math.ceil(st.size / 1024)} KB, over the 32 KB limit; shorten it so every instruction reaches the review`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
