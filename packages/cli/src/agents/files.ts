// File helpers for `init`: atomic writes and the ownership marker.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// The line that marks a rule or skill file as written by `init`, so a later
// run may update it and `--uninstall` may remove it.
export const FILE_MARKER = "<!-- openqodex: written by openqodex init; openqodex init --uninstall removes it -->";

export function writeAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Puts the marker after the frontmatter when there is one (frontmatter must
// stay first for Cursor rules and skills), else on the first line.
export function withMarker(content: string): string {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 3);
    if (end !== -1) {
      const cut = end + "\n---\n".length;
      return `${content.slice(0, cut)}${FILE_MARKER}\n${content.slice(cut)}`;
    }
  }
  return `${FILE_MARKER}\n${content}`;
}

export function hasMarker(content: string): boolean {
  return content.split("\n").includes(FILE_MARKER);
}
