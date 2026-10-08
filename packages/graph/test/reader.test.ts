// How the graph reads the repository's own files: each read is decided by
// what the filesystem holds at that moment, never by how the path is
// spelled or by an answer kept from an earlier read. Ways a read could be
// led out of the repository, each on a real repository with real links:
// 1. A folder found to be a real folder on one read is swapped for a link
//    to a folder outside the repository before a later read; an answer kept
//    for that folder sends the later read through the link to the outside
//    file of the same name.
// 2. The inventory looks at a source file by its spelled path, so for a
//    tracked folder replaced by a link (a developer linking a local
//    checkout in) the file of that name outside decides whether the path
//    is listed as too big or unreadable: its size reaches the report.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { RepoReader } from "../src/safe-fs.js";
import { commitAll, makeRepo, writeFiles } from "./helpers.js";

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

  it("lists a source file under a folder that became a link as unreadable, never by the size of the file of that name outside (2)", async () => {
    const root = makeRepo({ "src/a.ts": "export const a = 1;\n", "main.ts": "export const m = 1;\n" });
    dirs.push(root);
    commitAll(root);
    const outside = temp("oq-outside-");
    writeFiles(outside, { "a.ts": `export const big = "${"x".repeat(4096)}";\n` });
    renameSync(join(root, "src"), join(temp("oq-aside-"), "src"));
    symlinkSync(outside, join(root, "src"));
    const g = await buildGraph({ repoRoot: root, store: null, maxFileBytes: 1024 });
    expect(g.status.notRead.filter((n) => n.file === "src/a.ts")).toEqual([{ file: "src/a.ts", reason: "unreadable" }]);
  });
});
