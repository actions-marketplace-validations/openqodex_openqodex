// The server profile's snapshots (reviewChange): a detached git work tree of
// the head commit, made in a fresh folder under the caller's work folder and
// filled with every link written as a plain file, the way the laptop's are
// (the CLI's checkout.ts). The folder and git's record of the work tree in
// the clone go when the review ends. The commit's own files stay as the
// change has them: the host gives the config, so nothing is placed over
// them. Making it runs nothing from the clone: no hook, no filter, no
// submodule, no fetch of a missing object.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenQodexError, safeGit } from "@openqodex/core";
import type { Snapshot, SnapshotMaker } from "./review-change.js";
import { lfsPaths } from "./snapshot.js";

export function serverSnapshots(workDir: string): SnapshotMaker {
  const remove = async (repoRoot: string, snapshot: Snapshot): Promise<void> => {
    await safeGit(repoRoot, ["worktree", "remove", "--force", snapshot.tree]);
    rmSync(snapshot.folder, { recursive: true, force: true });
    await safeGit(repoRoot, ["worktree", "prune"]);
  };
  return {
    async make(repoRoot, sha, prefix) {
      const folder = mkdtempSync(join(workDir, `snapshot-${prefix}`));
      const tree = join(folder, "tree");
      const fail = async (step: string, stderr: string): Promise<never> => {
        await remove(repoRoot, { folder, tree });
        const why = stderr.trim().split("\n")[0] ?? "";
        if (/lazy fetch|promisor|missing (blob|tree|object)|unable to read|bad object/i.test(stderr)) {
          throw new OpenQodexError(`a tree or file of ${sha.slice(0, 12)} is not in the clone (a partial clone), and openqodex fetches nothing; fetch the head commit's trees and files before the review (${why})`);
        }
        throw new OpenQodexError(`could not ${step} ${sha.slice(0, 12)} to review it: ${why}`);
      };
      const added = await safeGit(repoRoot, ["worktree", "add", "--no-checkout", "--detach", "--quiet", tree, sha]);
      if (added.code !== 0) return fail("add a work tree for", added.stderr);
      // core.symlinks=false: a link becomes a small file holding its target
      // text, so no tool that reads the snapshot follows it out.
      const filled = await safeGit(tree, ["-c", "core.symlinks=false", "read-tree", "--reset", "-u", "HEAD"]);
      if (filled.code !== 0) return fail("check out", filled.stderr);
      return { folder, tree };
    },
    placeSettings() {},
    lfsPaths,
    remove,
    removeNow(repoRoot, snapshot) {
      rmSync(snapshot.folder, { recursive: true, force: true });
      spawnSync("git", ["worktree", "prune"], { cwd: repoRoot, stdio: "ignore", timeout: 5_000 });
    },
  };
}
