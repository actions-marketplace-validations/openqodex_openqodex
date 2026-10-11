#!/usr/bin/env node
// Builds a benchmark case into the repository a review reads, to look at or
// to review by hand (benchmark/build.mjs is the same command):
//
//   node benchmark/materialise.mjs <case> [folder] [--shape laptop|server]
//       builds the case into folder (a new temp folder when left out) and
//       prints the repository's path. laptop (the default): the base
//       committed and the change uncommitted; server: the base and the
//       change as two commits.
//   node benchmark/materialise.mjs --check <case>...
//       builds each case in both shapes in temp folders, runs a full fsck
//       of each case repository again, prints what it proved, and removes
//       the folders; exit 1 when a check fails
//   node benchmark/materialise.mjs --prune
//       lists the clone cache's folders and sizes; nothing is removed, a
//       person moves what to free to the Trash
//
// <case> is a planted case's name, <suite>/<name> for a pull request case,
// or a full case id (<suite>/<name>@<hash8>). A pull request case is fetched
// from its clone URL into the clone cache ($OPENQODEX_BENCH_CACHE, default
// ~/.cache/openqodex-bench) once; lib/materialise.mjs holds the rules. A
// held-out case is refused here: only a release run or run.mjs
// --materialise-only builds one, and they log the access.
// Exit codes: 0 done, 1 a build or a check failed, 2 refused.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, listCases as plantedNames } from "./lib/cases.mjs";
import { cacheRoot } from "./lib/licence.mjs";
import { cacheListing, prRefusal, seenTree, verifyCaseRepo } from "./lib/materialise.mjs";
import { listCases, materialise, readCase, readSuite, realCaseId } from "./lib/suites.mjs";

const USAGE = "usage: node benchmark/materialise.mjs <case> [folder] [--shape laptop|server]\n       node benchmark/materialise.mjs --check <case>...\n       node benchmark/materialise.mjs --prune";

class Refused extends Error {}

// A planted name, <suite>/<name> or a full id, to the case.
export function resolveCase(arg) {
  if (plantedNames().includes(arg)) {
    const id = listCases({ suite: "planted" }).find((i) => i.startsWith(`planted/${arg}@`));
    if (!id) throw new Refused(`${arg} is retired in benchmark/cases.lock.json`);
    return readCase(id);
  }
  if (/^[a-z]+\/[^@\s]+@[0-9a-f]{8}$/.test(arg)) return readCase(arg);
  const m = /^([a-z]+)\/([^@\s/]+)$/.exec(arg);
  if (m && m[1] !== "planted") {
    const entry = readSuite(m[1]).byName.get(m[2]);
    if (!entry) throw new Refused(`suite ${m[1]} holds no case named ${m[2]}`);
    return readCase(realCaseId(m[1], m[2], entry.hash));
  }
  throw new Refused(`${arg} is not a planted case, <suite>/<name> or a case id\nplanted cases: ${plantedNames().join(", ")}`);
}

const short = (sha) => (sha ? sha.slice(0, 12) : "none");
const count = (dir, rev) => Number(git(dir, "rev-list", "--count", rev).trim());

// Builds one case in both shapes and returns the lines it proved, and
// whether every check held.
function check(c) {
  const started = Date.now();
  const temp = mkdtempSync(join(tmpdir(), "oq-bench-check-"));
  const said = [];
  let ok = true;
  const expect = (holds, text) => {
    said.push(`  ${holds ? "ok  " : "FAIL"} ${text}`);
    if (!holds) ok = false;
  };
  try {
    const laptop = materialise(c, join(temp, "laptop", "repo"), { shape: "laptop" });
    const server = materialise(c, join(temp, "server", "repo"), { shape: "server" });
    if (c.materialise.kind === "pr") {
      // Reads every object of the case repository again (a full fsck).
      const record = verifyCaseRepo(c);
      const u = record.upstream;
      expect(true, `case repository: ${record.fsck}`);
      said.unshift(`${c.id}: ${c.changeLines ?? "?"} changed lines; head ${short(u.headSha)}, merge base ${short(u.mergeBaseSha)} (from ${u.mergeBaseFrom}; the dataset's base ${short(u.baseSha)}${u.baseSha === u.mergeBaseSha ? " is the merge base" : " is not"})`);
      expect(record.headTree === u.headTree && git(server.dir, "rev-parse", "HEAD^{tree}").trim() === u.headTree, `head tree ${u.headTree} is upstream's`);
      expect(record.baseTree === u.mergeBaseTree && git(server.dir, "rev-parse", "HEAD~1^{tree}").trim() === u.mergeBaseTree, `base tree ${u.mergeBaseTree} is the upstream merge base's`);
      said.push(`  case repository ${laptop.built ? "built now" : "already built"}; both shapes in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    } else {
      said.unshift(`${c.id}: planted`);
    }
    const status = git(laptop.dir, "status", "--porcelain", "-uall").split("\n").filter(Boolean);
    const kinds = { modified: 0, added: 0, deleted: 0, other: 0 };
    for (const line of status) kinds[line.startsWith("??") ? "added" : line[1] === "M" ? "modified" : line[1] === "D" ? "deleted" : "other"] += 1;
    expect(count(laptop.dir, "HEAD") === 1 && status.length > 0, `laptop: 1 commit, and the change in the working tree: ${kinds.modified} modified, ${kinds.added} new (untracked), ${kinds.deleted} deleted${kinds.other ? `, ${kinds.other} other` : ""}`);
    const headTree = git(server.dir, "rev-parse", "HEAD^{tree}").trim();
    expect(seenTree(laptop.dir) === headTree, "laptop: the tree a review sees is the head's");
    const files = git(server.dir, "diff-tree", "-r", "--name-only", "HEAD~1", "HEAD").split("\n").filter(Boolean).length;
    expect(count(server.dir, "HEAD") === 2 && count(server.dir, "--all") === 2 && git(server.dir, "status", "--porcelain", "-uall").trim() === "", `server: 2 commits, ${files} files changed between them, nothing uncommitted`);
  } catch (error) {
    said.push(`  FAIL ${error.message}`);
    ok = false;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  return { ok, said };
}

export function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === "--prune") {
      if (argv.length > 1) throw new Refused(USAGE);
      const listing = cacheListing();
      if (listing.length === 0) console.log(`The clone cache ${cacheRoot()} holds nothing.`);
      for (const { path, bytes } of listing) console.log(`${(bytes / 1e6).toFixed(1).padStart(10)} MB  ${path}`);
      if (listing.length > 0) console.log(`${(listing.reduce((s, x) => s + x.bytes, 0) / 1e6).toFixed(1).padStart(10)} MB  in all. Nothing was removed: move a folder to the Trash to free it.`);
      return 0;
    }
    if (argv[0] === "--check") {
      const cases = argv.slice(1).map(resolveCase);
      if (cases.length === 0) throw new Refused(USAGE);
      for (const c of cases) if (c.materialise.kind === "pr" && prRefusal(c)) throw new Refused(prRefusal(c));
      let failed = 0;
      for (const c of cases) {
        const { ok, said } = check(c);
        console.log(said.join("\n"));
        if (!ok) failed += 1;
      }
      console.log(failed === 0 ? `All ${cases.length} cases hold.` : `${failed} of ${cases.length} cases failed a check.`);
      return failed === 0 ? 0 : 1;
    }
    const shapeAt = argv.indexOf("--shape");
    const shape = shapeAt === -1 ? "laptop" : argv[shapeAt + 1];
    const rest = shapeAt === -1 ? argv : argv.filter((_, i) => i !== shapeAt && i !== shapeAt + 1);
    if (rest.length < 1 || rest.length > 2 || rest.some((a) => a.startsWith("--")) || (shape !== "laptop" && shape !== "server")) throw new Refused(USAGE);
    const c = resolveCase(rest[0]);
    if (c.materialise.kind === "pr" && prRefusal(c)) throw new Refused(prRefusal(c));
    const into = rest[1] === undefined ? join(mkdtempSync(join(tmpdir(), `oq-bench-${c.name}-`)), "repo") : resolve(rest[1]);
    console.log(materialise(c, into, { shape }).dir);
    return 0;
  } catch (error) {
    console.error(error.message);
    return error instanceof Refused ? 2 : 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
