// What the project model read and looked for, recorded while it is built,
// so a kept index is matched by exactly those files: each path read, with
// its content id or why it could not be read, and each path looked for,
// found or not. A name filter would miss what a config names freely (a
// tsconfig `extends` of `./configs/base`, with no extension) and a file
// whose absence decided something (`./configs/base` as written, before
// `configs/base.json`).
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { blobId } from "../capture/inventory.js";
import type { RepoReader } from "../safe-fs.js";

export type ReadTrace = {
  reader: RepoReader; // reads through the real reader and records each one
  look: (path: string, found: boolean) => void; // a path looked for in git's list
  entries: () => [string, string][]; // sorted by path
};

export function traceReads(real: RepoReader): ReadTrace {
  const seen = new Map<string, string>();
  const record = (path: string, bytes: Buffer | null) => {
    if (bytes !== null) {
      seen.set(path, `blob ${blobId(bytes)}`);
      return;
    }
    // Why it was not read: absent, a link or not a file, or over the cap.
    let why = "absent";
    try {
      const st = lstatSync(join(real.root, path));
      why = st.isFile() ? `unread ${st.size}` : st.isSymbolicLink() ? "link" : "not a file";
    } catch {
      // absent
    }
    seen.set(path, why);
  };
  const reader = {
    root: real.root,
    read(path: string, maxBytes: number): string | null {
      const bytes = real.readBytes(path, maxBytes);
      record(path, bytes);
      return bytes === null ? null : bytes.toString("utf8");
    },
    readBytes(path: string, maxBytes: number): Buffer | null {
      const bytes = real.readBytes(path, maxBytes);
      record(path, bytes);
      return bytes;
    },
  } as unknown as RepoReader;
  return {
    reader,
    look: (path, found) => {
      if (!seen.has(path)) seen.set(path, found ? "listed" : "not listed");
    },
    entries: () => [...seen].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  };
}
