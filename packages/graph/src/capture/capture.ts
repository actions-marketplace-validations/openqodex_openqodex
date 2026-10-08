// A capture: the bytes a graph was built from, written as a git tree into
// the repository's own object store, so `git show <tree>:<path>` reads them
// after the files change and after the review deletes its snapshot. The
// store keeps the tree alive under refs/openqodex/graph/<tree> while a
// generation built from it is kept (PLAN.md 3.2.0, decision 11).
//
// Neither function touches the developer's index: each works on a copy in
// a temporary folder. Every git call goes through safeGit, so no hook,
// filter or fetch runs.
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { safeGit } from "@openqodex/core";

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

async function withIndexCopy<T>(root: string, run: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const tmp = mkdtempSync(join(tmpdir(), "openqodex-capture-"));
  try {
    const index = await gitPath(root, "index");
    const copy = join(tmp, "index");
    if (existsSync(index)) copyFileSync(index, copy);
    return await run({ GIT_INDEX_FILE: copy });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// The work tree of `root` as it is now: tracked, changed and untracked files
// (not ignored ones), their blobs written into the repository's objects.
export async function captureWorkingTree(root: string): Promise<string> {
  return withIndexCopy(root, async (env) => {
    await ok(root, ["add", "-A", "--", "."], env);
    return (await ok(root, ["write-tree"], env)).toString("utf8").trim();
  });
}

// The review snapshot (a linked work tree of the repository, filled from a
// tree whose new blobs lived in a temporary object folder, then redacted):
// every file it holds now, with the blobs the repository does not have yet
// (changed, untracked and redacted files) written into its objects.
export async function captureSnapshot(snapshot: string): Promise<string> {
  return withIndexCopy(snapshot, async (env) => {
    const split = (b: Buffer) => b.toString("utf8").split("\0").filter(Boolean);
    const staged = new Map<string, string>();
    for (const rec of split(await ok(snapshot, ["ls-files", "-s", "-z"], env))) {
      const tab = rec.indexOf("\t");
      const [mode, id] = rec.slice(0, tab).split(" ");
      if ((mode === "100644" || mode === "100755") && id) staged.set(rec.slice(tab + 1), id);
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
    const present: string[] = [];
    const lines: string[] = [];
    for (const path of changed) {
      let st;
      try {
        st = lstatSync(join(snapshot, path));
      } catch {
        st = null;
      }
      if (st?.isFile()) present.push(path);
      else lines.push(`0 ${"0".repeat(40)}\t${path}`); // removed from the snapshot (redaction): out of the tree
    }
    if (present.length > 0) {
      const written = (await ok(snapshot, ["hash-object", "-w", "--no-filters", "--stdin-paths"], env, `${present.join("\n")}\n`)).toString("utf8").trim().split("\n");
      present.forEach((path, i) => {
        const exec = (lstatSync(join(snapshot, path)).mode & 0o111) !== 0;
        lines.push(`${exec ? "100755" : "100644"} ${written[i]}\t${path}`);
      });
    }
    if (lines.length > 0) await ok(snapshot, ["update-index", "-z", "--index-info"], env, `${lines.join("\0")}\0`);
    return (await ok(snapshot, ["write-tree"], env)).toString("utf8").trim();
  });
}

// The content id of each path in a tree, for the paths asked.
export async function treeBlobs(root: string, tree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await safeGit(root, ["ls-tree", "-r", "-z", "--full-tree", tree]);
  if (r.code !== 0) throw new Error(`git ls-tree failed: ${r.stderr.trim()}`);
  for (const rec of r.stdout.toString("utf8").split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    const [, type, id] = rec.slice(0, tab).split(" ");
    if (type === "blob" && id) out.set(rec.slice(tab + 1), id);
  }
  return out;
}
