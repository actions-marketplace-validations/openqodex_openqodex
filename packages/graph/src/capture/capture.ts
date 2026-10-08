// A capture: the bytes a graph was built from, written as a git tree into
// the repository's own object store, so `git show <tree>:<path>` reads them
// after the files change and after the review deletes its snapshot. The
// store keeps the tree alive under refs/openqodex/graph/<tree> while a
// generation built from it is kept (PLAN.md 3.2.0, decision 11).
//
// Only the files of the captured tree are stored, and only from inside the
// folder captured: a symbolic link is stored as a link (its target text),
// never followed; a path is read only when every folder on the way is a
// real folder; nothing outside the root is read into an object. Neither
// function touches the developer's index: each works on a copy in a
// temporary folder. Every git call goes through safeGit, so no hook, filter
// or fetch runs, and no path from the repository is placed where git reads
// an option.
import { copyFileSync, existsSync, lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { safeGit } from "@openqodex/core";
import { RepoReader } from "../safe-fs.js";
import { isRepoRelative, isSha } from "./git.js";

// A snapshot file larger than this is left out of the capture's tree.
const MAX_CAPTURE_FILE_BYTES = 64 * 1024 * 1024;

async function gitPath(root: string, name: string): Promise<string> {
  const r = await safeGit(root, ["rev-parse", "--git-path", name]);
  if (r.code !== 0) throw new Error(`git rev-parse failed: ${r.stderr.trim()}`);
  const p = r.stdout.toString("utf8").trim();
  return isAbsolute(p) ? p : resolve(root, p);
}

async function ok(root: string, args: string[], env: Record<string, string>, input?: string): Promise<Buffer> {
  const r = await safeGit(root, args, input, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split("\n")[0] ?? ""}`);
  return r.stdout;
}

async function withIndexCopy<T>(root: string, run: (env: Record<string, string>, tmp: string) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "openqodex-capture-"));
  try {
    const index = await gitPath(root, "index");
    const copy = join(tmp, "index");
    if (existsSync(index)) copyFileSync(index, copy);
    return await run({ GIT_INDEX_FILE: copy }, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const tree = (b: Buffer): string => {
  const sha = b.toString("utf8").trim();
  if (!isSha(sha)) throw new Error("git write-tree gave no tree id");
  return sha;
};

// The work tree of `root` as it is now: tracked, changed and untracked files
// (not ignored ones), their blobs written into the repository's objects.
// git add stores a link as a link and adds nothing beyond one.
export async function captureWorkingTree(root: string): Promise<string> {
  return withIndexCopy(root, async (env) => {
    await ok(root, ["add", "-A", "--", "."], env);
    return tree(await ok(root, ["write-tree"], env));
  });
}

// The review snapshot (a linked work tree of the repository, filled from a
// tree whose new blobs lived in a temporary object folder, then redacted):
// every file it holds now, with the blobs the repository does not have yet
// (changed, untracked and redacted files) written into its objects.
export async function captureSnapshot(snapshot: string): Promise<string> {
  const reader = new RepoReader(snapshot);
  return withIndexCopy(snapshot, async (env, tmp) => {
    const split = (b: Buffer) => b.toString("utf8").split("\0").filter(Boolean);
    const staged = new Map<string, string>();
    for (const rec of split(await ok(snapshot, ["ls-files", "-s", "-z"], env))) {
      const tab = rec.indexOf("\t");
      const [mode, id] = rec.slice(0, tab).split(" ");
      if ((mode === "100644" || mode === "100755" || mode === "120000") && id && isSha(id)) staged.set(rec.slice(tab + 1), id);
    }
    // Blobs the repository's objects lack: the snapshot's index names them,
    // but they were written to the temporary folder the change source removed.
    const ids = [...new Set(staged.values())];
    const missing = new Set<string>();
    if (ids.length > 0) {
      const check = (await ok(snapshot, ["cat-file", "--batch-check"], env, `${ids.join("\n")}\n`)).toString("utf8");
      for (const line of check.split("\n")) if (line.endsWith(" missing")) missing.add(line.slice(0, line.indexOf(" ")));
    }
    const changed = new Set(split(await ok(snapshot, ["diff-files", "--name-only", "-z", "--no-ext-diff"], env)));
    for (const [path, id] of staged) if (missing.has(id)) changed.add(path);
    // Each changed path's bytes, read here with no link followed, copied to
    // a temporary file of our own naming; git hashes those copies. A path
    // that fails its check, or a file that is not a regular file or a link,
    // leaves the tree.
    const records: string[] = [];
    const copies: { path: string; mode: string; file: string }[] = [];
    for (const path of changed) {
      let st = null;
      try {
        st = isRepoRelative(path) ? lstatSync(join(snapshot, path)) : null;
      } catch {
        st = null;
      }
      const file = join(tmp, `blob-${copies.length}`);
      if (st?.isSymbolicLink()) {
        writeFileSync(file, readlinkSync(join(snapshot, path)), { flag: "wx" });
        copies.push({ path, mode: "120000", file });
        continue;
      }
      const bytes = st?.isFile() ? reader.readBytes(path, MAX_CAPTURE_FILE_BYTES) : null;
      if (bytes === null) {
        records.push(`0 ${"0".repeat(40)}\t${path}`);
        continue;
      }
      writeFileSync(file, bytes, { flag: "wx" });
      copies.push({ path, mode: ((st?.mode ?? 0) & 0o111) !== 0 ? "100755" : "100644", file });
    }
    if (copies.length > 0) {
      const written = (await ok(snapshot, ["hash-object", "-w", "--no-filters", "--stdin-paths"], env, `${copies.map((c) => c.file).join("\n")}\n`)).toString("utf8").trim().split("\n");
      copies.forEach((c, i) => {
        const id = written[i] ?? "";
        if (!isSha(id)) throw new Error("git hash-object gave no blob id");
        records.push(`${c.mode} ${id}\t${c.path}`);
      });
    }
    if (records.length > 0) await ok(snapshot, ["update-index", "-z", "--index-info"], env, `${records.join("\0")}\0`);
    return tree(await ok(snapshot, ["write-tree"], env));
  });
}

// The content id of each path in a tree.
export async function treeBlobs(root: string, treeSha: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isSha(treeSha)) throw new Error("not a tree id");
  const r = await safeGit(root, ["ls-tree", "-r", "-z", "--full-tree", treeSha]);
  if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim()}`);
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    const [, type, id] = rec.slice(0, tab).split(" ");
    if (type === "blob" && id) out.set(rec.slice(tab + 1), id);
  }
  return out;
}
