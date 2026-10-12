// The proof-only build of a run's cases (run.mjs --materialise-only): every
// selected case is built through lib/suites.mjs materialise, in the shape
// the run's mode needs, and what was built is proved and recorded. No
// scanner, no reviewer and no model runs, no truth is read, and nothing is
// spent. It is the one way a held-out case is built before a release.
//
// The proof of each case:
//   caseId, suite, name, split, licence (class, SPDX id, the option chosen)
//   upstream  a pull request case's dataset base and head, its merge base
//             and where that came from (git, or frozen in the entry), every
//             merge base git found in the order of the rule the record
//             names, that rule, and the merge base's and the head's
//             trees, from the case repository's record
//   built     the base and the head a review would name, the base's tree,
//             the head's tree as the review sees it, and the fsck the case
//             repository passed
//   trees     whether the built trees are upstream's
//   ancestor  whether the merge base is an ancestor of the head: in the
//             clone cache's history for a pull request case
//             (lib/materialise.mjs mergeBaseAncestry, which deepens that
//             repository's commits cache when it is too shallow to answer,
//             and records the deepening), in the built repository for a
//             planted case in the server shape
//   ok        proved; else `error` says why
//
// Failure list, written before the code:
// 1. A held-out case is built with no line in the held-out access log: one
//    line per suite (purpose "materialise-only") is appended before any
//    case is built, and a line that cannot be written refuses the whole
//    build. lib/materialise.mjs also logs each held-out case in the cache.
// 2. One case that cannot be built (a licence refusal, a failed fetch, a
//    tree that differs) stops the others, or is counted as proved: each case
//    is proved or failed on its own, with its reason.
// 3. A held-out case's truth is read: nothing here reads truth.
// 4. A case's folder is left behind: each is removed after its proof.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { casesRoot, git, gitEnv } from "./cases.mjs";
import { cacheRoot } from "./licence.mjs";
import { mergeBaseAncestry, seenTree } from "./materialise.mjs";
import { materialise } from "./suites.mjs";

const firstLine = (error) => String(error?.message ?? error).split("\n")[0];

// What every proof starts with: which case, and its licence.
function about(c) {
  const l = c.source?.licence ?? null;
  return { caseId: c.id, suite: c.suite, name: c.name, split: c.split, licence: l ? { class: l.class ?? null, spdx: l.spdx ?? null, chosen: l.chosen ?? null } : null };
}

// git's yes or no to "is `a` an ancestor of `b`" in `dir`.
function isAncestor(dir, a, b) {
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: dir, env: gitEnv(), encoding: "utf8" });
  if (r.status === 0) return { isAncestor: true, why: null };
  return { isAncestor: r.status === 1 ? false : null, why: `git merge-base --is-ancestor answered ${r.status}${r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ""}` };
}

// Builds one case into `into` and proves it.
function prove(c, into, { shape, cache, casesDir, allowFileUrl }) {
  const r = materialise(c, into, { shape, cache, heldOut: c.split === "test", casesDir, allowFileUrl });
  const tree = (rev) => git(r.dir, "rev-parse", `${rev}^{tree}`).trim();
  const headTree = shape === "server" ? tree(r.head) : seenTree(r.dir);
  if (c.materialise?.kind !== "pr") {
    const ancestor = shape === "server" ? isAncestor(r.dir, r.base, r.head) : { isAncestor: null, why: "the laptop shape leaves a planted change uncommitted" };
    const ok = shape !== "server" || ancestor.isAncestor === true;
    return { ...about(c), shape, ok, error: ok ? null : ancestor.why, upstream: null, built: { base: r.base, head: r.head, baseTree: tree(r.base), headTree }, trees: null, ancestor };
  }
  const record = JSON.parse(readFileSync(join(r.caseRepo, "materialised.json"), "utf8"));
  const u = record.upstream;
  const built = { base: r.base, head: r.head, baseTree: tree(r.base), headTree, fsck: record.fsck };
  const trees = { base: built.baseTree === u.mergeBaseTree, head: built.headTree === u.headTree };
  const ancestor = mergeBaseAncestry(c, u.mergeBaseSha, { cache, allowFileUrl });
  const problems = [...(trees.base ? [] : [`the base tree ${built.baseTree} is not the merge base's ${u.mergeBaseTree}`]), ...(trees.head ? [] : [`the head tree ${built.headTree} is not upstream's ${u.headTree}`]), ...(ancestor.isAncestor === true ? [] : [ancestor.why])];
  return {
    ...about(c),
    shape,
    ok: problems.length === 0,
    error: problems.length === 0 ? null : problems.join("; "),
    upstream: { baseSha: u.baseSha, headSha: u.headSha, mergeBaseSha: u.mergeBaseSha, mergeBaseFrom: u.mergeBaseFrom, mergeBases: u.mergeBases ?? null, mergeBaseRule: u.mergeBaseRule ?? null, mergeBaseTree: u.mergeBaseTree, headTree: u.headTree },
    built,
    trees,
    ancestor,
    caseRepo: r.built ? "built now" : "already built",
  };
}

/**
 * Builds and proves `cases` (lib/suites.mjs case records) in `shape`, each
 * in its own folder under `workRoot`, removed after. Held-out cases (split
 * "test") get one line per suite in `accessLog` first ({ at, suite,
 * caseCount, purpose: "materialise-only", runId: null, release: null, by });
 * throws, with nothing built, when it cannot be written. Returns the proof
 * record: { version, purpose, shape, startedAt, proved, failed, heldOut,
 * access, cases }. `log(proof)` is told of each case as it is proved.
 */
export function materialiseOnly({ cases, shape, workRoot, accessLog, by = null, cache = cacheRoot(), casesDir = casesRoot, allowFileUrl = false, now = () => new Date().toISOString(), log = () => {} }) {
  if (shape !== "laptop" && shape !== "server") throw new Error(`the shape is laptop or server, not ${JSON.stringify(shape)}`);
  const startedAt = now();
  const held = new Map();
  for (const c of cases) if (c.split === "test") held.set(c.suite, (held.get(c.suite) ?? 0) + 1);
  const access = [];
  for (const [suite, caseCount] of held) {
    const line = { at: now(), suite, caseCount, purpose: "materialise-only", runId: null, release: null, by };
    try {
      mkdirSync(dirname(accessLog), { recursive: true });
      appendFileSync(accessLog, `${JSON.stringify(line)}\n`);
    } catch (error) {
      throw new Error(`the held-out access log ${accessLog} cannot be written (${firstLine(error)}), so no held-out case is built`);
    }
    access.push(line);
  }
  const proofs = [];
  for (const c of cases) {
    const folder = mkdtempSync(join(workRoot, "m-"));
    let proof;
    try {
      proof = prove(c, join(folder, "repo"), { shape, cache, casesDir, allowFileUrl });
    } catch (error) {
      proof = { ...about(c), shape, ok: false, error: firstLine(error) };
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
    proofs.push(proof);
    log(proof);
  }
  const proved = proofs.filter((p) => p.ok).length;
  return { version: 1, purpose: "materialise-only", shape, startedAt, proved, failed: proofs.length - proved, heldOut: [...held.values()].reduce((a, b) => a + b, 0), access, cases: proofs };
}
