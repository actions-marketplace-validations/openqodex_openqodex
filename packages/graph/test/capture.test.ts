// The capture: the bytes a build read, written as a git tree into the
// repository's objects. Ways it could be turned against the developer, each
// on a real repository:
// 1. A symbolic link in the work tree (to ~/.ssh/id_rsa) is followed, so
//    the file it points at lands in the repository's objects; a link must
//    be stored as a link, its target text and nothing more.
// 2. A tracked path whose name holds a line break and `../` is split by a
//    line-based git protocol, so a file outside the repository is read
//    into an object.
// 3. A file named like an option (`--output=x`, `-c`) is read by git as
//    one, so a capture or a base read writes a file or changes git's
//    settings.
// 4. A value from the repository (a tree id, a path) reaches git's
//    arguments without a strict check.
// 5. A tracked path under a folder the snapshot now holds as a link is
//    looked at through that link, so the target text of a link outside the
//    repository is stored in the repository's objects as the path's link.
// 6. A file edited at the same size in the second the index was written is
//    stored as it was before the edit. Git trusts a file's size and times
//    over its content unless the entry is as new as the index itself; the
//    capture's copy of the index carries a later time than the original, so
//    without the original's time git skips the edit (issue #85).
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChange } from "@openqodex/core";
import { captureSnapshot, captureWorkingTree, treeBlobs } from "../src/capture/capture.js";
import { isSafeRepoPath, isSha, showBlob } from "../src/capture/git.js";
import { blobId } from "../src/capture/inventory.js";
import { buildGraph } from "../src/index.js";
import { commitAll, git, makeRepo, writeFiles } from "./helpers.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const hasObject = (repo: string, id: string) => spawnSync("git", ["cat-file", "-e", id], { cwd: repo }).status === 0;

// A snapshot made the way the review makes one: a linked work tree of the
// repository at HEAD.
function snapshotOf(repo: string): string {
  const parent = tempDir("oq-snap-");
  dirs.push(parent);
  const snap = join(parent, "tree");
  git(repo, "worktree", "add", "--no-checkout", "--detach", snap, "HEAD");
  git(snap, "read-tree", "--reset", "-u", "HEAD");
  return snap;
}

function outsideSecret(): { path: string; text: string } {
  const dir = tempDir("oq-home-");
  dirs.push(dir);
  mkdirSync(join(dir, ".ssh"));
  const text = `-----BEGIN OPENSSH PRIVATE KEY----- ${Math.random()} -----END-----\n`;
  const path = join(dir, ".ssh", "id_rsa");
  writeFileSync(path, text);
  return { path, text };
}

describe("the capture", () => {
  it("stores a link in the work tree as a link and never the file it points at (1)", async () => {
    const secret = outsideSecret();
    const repo = makeRepo({ "a.ts": "export function a() {}\n", "leak": "placeholder\n" });
    dirs.push(repo);
    commitAll(repo);
    const snap = snapshotOf(repo);
    // In the work tree: a new link. In the snapshot: a tracked file replaced by a link.
    symlinkSync(secret.path, join(repo, "key"));
    rmSync(join(snap, "leak"));
    symlinkSync(secret.path, join(snap, "leak"));
    const work = await captureWorkingTree(repo);
    const snapTree = await captureSnapshot(snap);
    expect(hasObject(repo, blobId(Buffer.from(secret.text)))).toBe(false);
    // Each link is in its tree as a link: mode 120000, the target as its text.
    expect(git(repo, "ls-tree", work, "key")).toMatch(/^120000 blob /);
    expect(git(repo, "cat-file", "-p", `${work}:key`)).toBe(secret.path);
    expect(git(repo, "ls-tree", snapTree, "leak")).toMatch(/^120000 blob /);
    expect(git(repo, "cat-file", "-p", `${snapTree}:leak`)).toBe(secret.path);
  });

  it("never reads a file outside the repository through a path with a line break and `../` (2)", async () => {
    const parent = tempDir("oq-outside-");
    dirs.push(parent);
    const outside = `outside secret ${Math.random()}\n`;
    writeFileSync(join(parent, "outside.txt"), outside);
    const crafted = "x\n../outside.txt";
    const repo = makeRepo({ "a.ts": "export function a() {}\n", [crafted]: "tracked\n" });
    dirs.push(repo);
    commitAll(repo);
    // The snapshot sits right beside outside.txt, so `../outside.txt` from it names that file.
    const snap = join(parent, "tree");
    git(repo, "worktree", "add", "--no-checkout", "--detach", snap, "HEAD");
    git(snap, "read-tree", "--reset", "-u", "HEAD");
    writeFileSync(join(snap, crafted), "changed in the snapshot\n");
    const tree = await captureSnapshot(snap);
    expect(hasObject(repo, blobId(Buffer.from(outside)))).toBe(false);
    expect((await treeBlobs(repo, tree)).get(crafted)).toBe(blobId(Buffer.from("changed in the snapshot\n")));
  });

  it("treats files named like options as names, in the capture and in base reads (3)", async () => {
    const files = { "--output=x.ts": "export function f() {\n  return 1;\n}\n", "-c.ts": "export function g() {\n  return 1;\n}\n", "a.ts": "export function a() {}\n" };
    const repo = makeRepo(files);
    dirs.push(repo);
    commitAll(repo);
    writeFiles(repo, { "--output=x.ts": "export function f() {\n  return 2;\n}\n", "-c.ts": "export function h() {\n  return 3;\n}\n" });
    const before = readdirSync(repo).sort();
    const work = await captureWorkingTree(repo);
    const blobs = await treeBlobs(repo, work);
    expect(blobs.get("--output=x.ts")).toBe(blobId(Buffer.from("export function f() {\n  return 2;\n}\n")));
    expect(blobs.get("-c.ts")).toBe(blobId(Buffer.from("export function h() {\n  return 3;\n}\n")));
    const change = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    const graph = await buildGraph({ repoRoot: repo, store: null, files: change.changedPaths, base: { sha: change.baseSha, files: change.files } });
    // `g` is gone from -c.ts: its base version was read as a name.
    expect([...graph.removed.values()].flat().map((n) => n.name)).toContain("g");
    expect(readdirSync(repo).sort()).toEqual(before);
    expect(existsSync(join(process.cwd(), "x"))).toBe(false);
  });

  it("stores nothing found through a folder the snapshot holds as a link, not even the text of a link outside (5)", async () => {
    const outside = tempDir("oq-outside-");
    dirs.push(outside);
    const text = `/outside/only/${Math.random()}`;
    symlinkSync(text, join(outside, "x.ts"));
    const repo = makeRepo({ "a.ts": "export function a() {}\n", "dir/x.ts": "export function x() {}\n" });
    dirs.push(repo);
    commitAll(repo);
    const snap = snapshotOf(repo);
    rmSync(join(snap, "dir"), { recursive: true });
    symlinkSync(outside, join(snap, "dir"));
    const tree = await captureSnapshot(snap);
    expect(hasObject(repo, blobId(Buffer.from(text)))).toBe(false);
    expect((await treeBlobs(repo, tree)).has("dir/x.ts")).toBe(false);
  });

  it("puts only checked values into git's arguments (4)", async () => {
    expect(isSha("a".repeat(40))).toBe(true);
    expect(isSha("a".repeat(64))).toBe(true);
    for (const bad of ["a".repeat(39), "A".repeat(40), "--output=x", `${"a".repeat(40)} `, "HEAD"]) expect(isSha(bad), bad).toBe(false);
    for (const good of ["a.ts", "src/b.ts", "-c.ts", "dir/--x"]) expect(isSafeRepoPath(good), good).toBe(true);
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a\0b", "a\nb", "./a"]) expect(isSafeRepoPath(bad), JSON.stringify(bad)).toBe(false);
    const repo = makeRepo({ "a.ts": "export function a() {}\n" });
    dirs.push(repo);
    const sha = commitAll(repo);
    expect((await showBlob(repo, sha, "a.ts", 1024))?.toString("utf8")).toBe("export function a() {}\n");
    expect(await showBlob(repo, "--output=x", "a.ts", 1024)).toBeNull();
    expect(await showBlob(repo, sha, "../a.ts", 1024)).toBeNull();
    // Over the byte cap: refused before it is read.
    expect(await showBlob(repo, sha, "a.ts", 4)).toBeNull();
    expect(existsSync(join(repo, "x"))).toBe(false);
  });

  it("stores a file edited at the same size in the second the index was written as it is now (6)", async () => {
    const repo = makeRepo({ "a.ts": "return 1;\n" });
    // Ctime is set by the system alone; with it ignored, the file's size and
    // mtime decide, as they do on every file system for an edit made within
    // the second.
    git(repo, "config", "core.trustctime", "false");
    // A whole second in the past: the commit writes the index later, so git
    // does not mark the entry as one to compare by content.
    const second = Math.floor(Date.now() / 1000) - 100;
    utimesSync(join(repo, "a.ts"), second, second);
    commitAll(repo);
    // The edit, at the same size and the same mtime, in the second the
    // index was written: the original index still asks git to compare it.
    writeFileSync(join(repo, "a.ts"), "return 2;\n");
    utimesSync(join(repo, "a.ts"), second, second);
    utimesSync(join(repo, ".git", "index"), second, second);
    expect(git(repo, "diff", "--name-only")).toBe("a.ts\n");
    const work = await captureWorkingTree(repo);
    expect((await treeBlobs(repo, work)).get("a.ts")).toBe(blobId(Buffer.from("return 2;\n")));
  });
});
