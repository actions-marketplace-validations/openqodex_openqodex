// Read helpers for `init` and `hook install`: reads that tell "absent" from
// "unreadable", and the symlink check for the exclude file git names. Every
// write, rename and delete goes through guarded-fs.ts.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

// The file's text, or null only when it does not exist. Any other error
// (permission denied, a folder in the way) is thrown with its reason.
export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error(`cannot read ${path} (${errorCode(error) ?? (error as Error).message})`);
  }
}

function refuseLink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symbolic link; openqodex does not write through links inside a repository`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

// The same check for a file git names (the exclude file) and its folder.
export function assertNotSymlink(path: string): void {
  refuseLink(dirname(path));
  refuseLink(path);
}
