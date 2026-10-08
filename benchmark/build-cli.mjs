#!/usr/bin/env node
// Builds the CLI for a benchmark run and records where the build came from:
//   node benchmark/build-cli.mjs
// Runs `pnpm build`, then writes benchmark/.build/provenance.json with the
// commit, the tree the build was made from (every file git sees, staged or
// not, untracked included), whether that tree differs from the commit's
// ("dirty"), and a hash of the bundle and its assets. run.mjs refuses a
// bundle whose hash is not the recorded one, so a run never names a commit
// its bundle was not built from.
//
// Failure list, written before the code:
// 1. The tree changes while the build runs (an editor saves a file): the
//    tree is read before and after; if they differ, nothing is recorded.
// 2. The build fails half way and a stale bundle is recorded as new: the
//    build's exit code is checked first.
// 3. "Dirty" is read later from the checkout, which may have changed since:
//    it is decided here, from the tree the build read.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { benchRoot, repoRoot } from "./lib/cases.mjs";
import { bundleHash, treeState } from "./lib/runner.mjs";

const before = treeState(repoRoot);
const build = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
if (build.status !== 0) {
  console.error(`pnpm build failed (exit ${build.status ?? build.signal}); nothing recorded`);
  process.exit(2);
}
const after = treeState(repoRoot);
if (after.tree !== before.tree || after.commit !== before.commit) {
  console.error("the tree changed while the CLI was building; nothing recorded. Build again on a quiet tree.");
  process.exit(2);
}
const provenance = {
  version: 1,
  commit: before.commit,
  tree: before.tree,
  commitTree: before.commitTree,
  dirty: before.dirty,
  bundleHash: bundleHash(join(repoRoot, "packages/cli")),
  builtAt: new Date().toISOString(),
  node: process.version,
};
mkdirSync(join(benchRoot, ".build"), { recursive: true });
writeFileSync(join(benchRoot, ".build", "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Built from ${provenance.commit.slice(0, 7)}${provenance.dirty ? ", with changes the commit does not hold (dirty)" : ""}; recorded in benchmark/.build/provenance.json`);
