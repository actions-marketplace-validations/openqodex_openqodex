// How the graph reads the repository's own files: each read is decided by
// what the filesystem holds at that moment, never by how the path is
// spelled or by an answer kept from an earlier read. Ways a read could be
// led out of the repository, each on a real repository with real links:
// 1. A folder found to be a real folder on one read is swapped for a link
//    to a folder outside the repository before a later read; an answer kept
//    for that folder sends the later read through the link to the outside
//    file of the same name.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoReader } from "../src/safe-fs.js";
import { makeRepo, writeFiles } from "./helpers.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("the repository reader", () => {
  it("reads nothing through a folder swapped for a link after an earlier read found it a real folder (1)", () => {
    const root = makeRepo({ "src/lib/a.ts": "export const inside = 1;\n" });
    dirs.push(root);
    const outside = temp("oq-outside-");
    writeFiles(outside, { "lib/a.ts": "export const outside = 1;\n" });
    const reader = new RepoReader(root);
    expect(reader.read("src/lib/a.ts", 1024)).toBe("export const inside = 1;\n");
    // The repository's src/ moves aside and a link to the outside folder takes its name.
    renameSync(join(root, "src"), join(temp("oq-aside-"), "src"));
    symlinkSync(outside, join(root, "src"));
    expect(reader.read("src/lib/a.ts", 1024)).toBeNull();
    expect(reader.readBytes("src/lib/a.ts", 1024)).toBeNull();
  });
});
