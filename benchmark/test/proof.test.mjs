// The proof over the outside suites (P4-03): benchmark/proof.mjs runs
// run.mjs --materialise-only over every case of a suite, on both sides of
// its split, and writes one summary per suite to
// benchmark/index/proof/<suite>-<date>.json; lib/materialise.mjs deepens a
// commits cache that is too shallow for the ancestry proof to answer.
//
// Pull request cases are built from a real upstream repository in a temp
// folder over file://. Git, the materialiser, the proof and the summary are
// the real ones; nothing here is faked.
//
// Failures guarded, written before the code:
// 1. A case whose merge base is not an ancestor of its head (the target
//    branch's tip recorded as the merge base after the target moved) is
//    summarised as proved, or is left out of the summary; so is a case that
//    did not build, a case with no proof, and a proof that says ok while its
//    ancestry is unknown.
// 2. A summary holds a machine path (the clone cache, the temp folder, the
//    home folder, this checkout, or any other absolute path, after a colon
//    or as a drive letter path too), which a committed file must never hold.
// 3. The ancestry proof on a commits cache that a later fetch made shallow
//    answers "history unknown" and stops there, or deepens without end: it
//    deepens that repository's commits cache up to a bound, records how deep
//    and how many commits it fetched, and says so when the bound is reached.
// 4. A summary trusts a proof's flags that its trees match while the tree
//    ids it records differ.
// 5. A summary names the checkout that summarised a saved proof folder as
//    the commit the proof ran on, or summarises a folder that records no
//    commit.
// 6. A case whose base and head have two merge bases (ClickHouse/ClickHouse
//    #80345) is never built, or is built on a merge base nobody chose: the
//    ingest freezes one by a fixed rule (the newest committer date, then the
//    smaller commit id), the case builds on it, and the proof records it
//    beside every merge base git found, in the rule's order, and the rule.
// 7. Two machines freeze different merge bases for one case, because the
//    two share a committer date and `git merge-base` alone picks by the
//    shape of the history: the commit id breaks the tie.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { benchRoot, git, gitEnv, repoRoot } from "../lib/cases.mjs";
import { MERGE_BASE_RULE, mergeBaseAncestry } from "../lib/materialise.mjs";
import { materialiseOnly } from "../lib/materialise-only.mjs";
import { SUITES, entryHash, freezeMergeBase, readCase, realCaseId } from "../lib/suites.mjs";
import { machinePathsIn, readProofRun, summariseProofs, writeSummary } from "../proof.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const out = (dir, ...args) => git(dir, ...args).trim();

// A real upstream: the merge base on main, a pull request of `prCommits`
// commits reachable only from refs/pull/7/head, then main moved on, so the
// dataset's base (main's tip) is not the merge base.
function upstream({ prCommits = 1 } = {}) {
  const dir = join(tempDir("oq-proof-up-"), "widget");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Base");
  const mergeBase = out(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  for (let n = 1; n <= prCommits; n++) {
    writeFileSync(join(dir, "a.txt"), `one\ntwo, changed ${n} times\n`);
    git(dir, "commit", "-q", "-am", `Feature ${n}`);
  }
  const headSha = out(dir, "rev-parse", "HEAD");
  const prCommitIds = out(dir, "rev-list", "--reverse", `${mergeBase}..${headSha}`).split("\n");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "b.txt"), "main moved on\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Main later");
  const baseSha = out(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/pull/7/head", headSha);
  git(dir, "branch", "-q", "-D", "feature");
  return { dir, baseSha, headSha, mergeBase, prCommitIds, baseTree: out(dir, "rev-parse", `${mergeBase}^{tree}`), headTree: out(dir, "rev-parse", `${headSha}^{tree}`) };
}

const MIT = { spdx: "MIT", chosen: "MIT", class: "permissive", file: "LICENSE", fileSha256: null, at: "the default branch", source: "the GitHub licence API", use: "local review and scoring", excerpts: "full" };

// A case in the shape lib/suites.mjs readCase returns for an AACR entry.
function prCase(up, { name = "acme__widget-7", repo = "acme/widget", split = "dev", mergeBaseSha = null, cloneUrl = `file://${up.dir}` } = {}) {
  const hash = createHash("sha256").update(`${up.dir}\0${up.headSha}\0${name}\0${cloneUrl}`).digest("hex");
  return {
    id: `aacr/${name}@${hash.slice(0, 8)}`,
    suite: "aacr",
    name,
    hash,
    split,
    status: "usable",
    excludedWhy: null,
    source: { repo, prUrl: `https://github.com/${repo}/pull/7`, cloneUrl, licence: MIT },
    materialise: { kind: "pr", cloneUrl, prRef: "refs/pull/7/head", baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha },
  };
}

const prove = (cases, cache) => ({ ...materialiseOnly({ cases, shape: "server", workRoot: tempDir("oq-proof-work-"), accessLog: join(tempDir("oq-proof-index-"), "heldout-access.jsonl"), by: "a test", cache, allowFileUrl: true }), suite: "aacr", split: "dev", subset: null });
const expected = (cases) => cases.map((c) => ({ id: c.id, split: c.split }));
const recordPath = (cache, c) => join(cache, "cases", `${c.hash}.git`, "materialised.json");
const editRecord = (cache, c, edit) => {
  const record = JSON.parse(readFileSync(recordPath(cache, c), "utf8"));
  edit(record);
  writeFileSync(recordPath(cache, c), `${JSON.stringify(record, null, 2)}\n`);
};
const commitsCache = (cache) => join(cache, "repos", "acme__widget.commits.git");
const shallowOf = (repo) => (existsSync(join(repo, "shallow")) ? readFileSync(join(repo, "shallow"), "utf8").split("\n").filter(Boolean) : []);

describe("a case whose merge base is not an ancestor of its head is summarised as proved, or left out", () => {
  it("reports the target branch's tip recorded as the merge base, a case that did not build, a case with no proof and an unknown ancestry as failures, each with its reason", { timeout: 120_000 }, () => {
    const up = upstream();
    const cache = tempDir("oq-proof-cache-");
    const good = prCase(up);
    const moved = prCase(up, { name: "acme__widget-8" });
    const frozen = prCase(up, { name: "acme__widget-9", mergeBaseSha: up.baseSha });
    const unknown = prCase(up, { name: "acme__widget-10" });
    const missing = prCase(up, { name: "acme__widget-11", split: "test" });
    const flagged = prCase(up, { name: "acme__widget-14" });
    expect(prove([good, moved, unknown, flagged], cache)).toMatchObject({ proved: 4, failed: 0 });
    // The record now names the target branch's tip as the merge base, as a
    // materialiser that took the tip after the target moved would write it.
    editRecord(cache, moved, (r) => {
      r.upstream.mergeBaseSha = up.baseSha;
    });
    const proof = prove([good, moved, frozen, unknown, flagged], cache);
    // A proof edited to say ok while its ancestry is unknown.
    const edited = proof.cases.find((p) => p.caseId === unknown.id);
    Object.assign(edited, { ok: true, error: null, ancestor: { isAncestor: null, why: "history unknown: the commits cache is shallow, and git found no path within it" } });
    // A proof whose flags say its trees match while the head tree it records is another tree.
    const wrongTree = proof.cases.find((p) => p.caseId === flagged.id);
    expect(wrongTree).toMatchObject({ ok: true, trees: { base: true, head: true } });
    wrongTree.built.headTree = up.baseTree;

    const ranOn = "a".repeat(40);
    const summarisedAt = "b".repeat(40);
    const summary = summariseProofs({ suite: "aacr", date: "2026-10-11", shape: "server", proofs: [proof], expected: expected([good, moved, frozen, unknown, missing, flagged]), cache, commit: ranOn, summarisedAt });
    expect(summary).toMatchObject({ commit: ranOn, summarisedAt });
    expect(summary.counts).toMatchObject({ cases: 6, proved: 1, failed: 5 });
    expect(summary.failures.map((f) => f.caseId).sort()).toEqual([moved.id, frozen.id, unknown.id, missing.id, flagged.id].sort());
    const byId = Object.fromEntries(summary.cases.map((c) => [c.caseId, c]));
    expect(byId[good.id]).toMatchObject({ ok: true, split: "dev", licence: { class: "permissive", spdx: "MIT" }, baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha: up.mergeBase, ancestorOfHead: true, trees: { mergeBase: up.baseTree, head: up.headTree, builtBase: up.baseTree, builtHead: up.headTree }, error: null });
    expect(byId[moved.id]).toMatchObject({ ok: false, mergeBaseSha: up.baseSha, ancestorOfHead: false });
    expect(byId[moved.id].error).toMatch(/is not an ancestor of/);
    expect(byId[frozen.id].ok).toBe(false);
    expect(byId[frozen.id].error).toMatch(/frozen mergeBaseSha/);
    expect(byId[unknown.id]).toMatchObject({ ok: false, ancestorOfHead: null });
    expect(byId[unknown.id].error).toMatch(/not proved an ancestor/);
    expect(byId[missing.id]).toMatchObject({ ok: false, split: "test" });
    expect(byId[missing.id].error).toMatch(/no proof/);
    expect(byId[flagged.id]).toMatchObject({ ok: false, trees: { head: up.headTree, builtHead: up.baseTree } });
    expect(byId[flagged.id].error).toContain(`the built head tree ${up.baseTree} is not upstream's head tree ${up.headTree}`);
  });
});

describe("a summary holds a machine path", () => {
  it("names the clone cache, the temp folder, the home folder and this checkout by placeholders only, and a summary that still holds one is never written", { timeout: 120_000 }, () => {
    const up = upstream();
    const cache = tempDir("oq-proof-cache-");
    const gone = prCase(up, { name: "acme__gone-12", repo: "acme/gone", cloneUrl: `file://${join(tempDir("oq-proof-gone-"), "missing")}` });
    const damaged = prCase(up, { name: "acme__widget-13" });
    prove([damaged], cache);
    editRecord(cache, damaged, (r) => {
      delete r.fsck;
    });
    const proof = prove([gone, damaged], cache);
    // The proof itself names this machine's folders: that is what the summary must not keep.
    expect(JSON.stringify(proof)).toContain(cache);
    // Another machine's paths, one right after a colon and one with a drive
    // letter, beside a URL that must stay as it is.
    const goneProof = proof.cases.find((p) => p.caseId === gone.id);
    goneProof.error += " (cwd:/Users/another/cache/repo; D:\\work\\repo; C:/work/other; see https://github.com/acme/widget.git)";

    const summary = summariseProofs({ suite: "aacr", date: "2026-10-11", shape: "server", proofs: [proof], expected: expected([gone, damaged]), cache });
    const text = JSON.stringify(summary);
    const real = (p) => realpathSync(p);
    for (const p of [cache, real(cache), tmpdir(), real(tmpdir()), homedir(), repoRoot, "/Users/another", "D:", "C:/work"]) expect(text).not.toContain(p);
    expect(machinePathsIn(text)).toEqual([]);
    const byId = Object.fromEntries(summary.cases.map((c) => [c.caseId, c]));
    expect(byId[damaged.id].error).toMatch(/<cache>\/cases\/[0-9a-f]{64}\.git is damaged/);
    expect(byId[gone.id].ok).toBe(false);
    expect(byId[gone.id].error).toMatch(/is gone from file:\/\/<path>/);
    expect(byId[gone.id].error).toContain("(cwd:<path>; <path>; <path>; see https://github.com/acme/widget.git)");

    const file = join(tempDir("oq-proof-out-"), "proof", "aacr-2026-10-11.json");
    for (const note of [`built in ${cache}`, "cwd:/Users/another/cache/repo", "at D:\\work\\repo", "(C:/work/other)"]) expect(() => writeSummary(file, { ...summary, note })).toThrow(/machine path/);
    expect(existsSync(file)).toBe(false);
    writeSummary(file, summary);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(summary);
  });
});

describe("the ancestry proof stops at history unknown on a commits cache a later fetch made shallow, or deepens without end", () => {
  it("deepens that repository's commits cache until git answers, up to its bound, and records how deep it went and how many commits it fetched", { timeout: 120_000 }, () => {
    const up = upstream({ prCommits: 5 });
    const cache = tempDir("oq-proof-cache-");
    const c = prCase(up);
    const first = prove([c], cache);
    expect(first.cases[0]).toMatchObject({ ok: true, ancestor: { isAncestor: true, deepening: null } });

    // A later case's fetch takes a commit of this pull request at depth 1,
    // which cuts the path from the head back to the merge base.
    const commits = commitsCache(cache);
    const cut = up.prCommitIds[1];
    execFileSync("git", ["fetch", "-q", "--no-tags", "--filter=tree:0", "--depth=1", "origin", cut], { cwd: commits, env: { ...gitEnv(), GIT_NO_LAZY_FETCH: "1" } });
    expect(shallowOf(commits)).toContain(cut);

    const bounded = mergeBaseAncestry(c, up.mergeBase, { cache, allowFileUrl: true, depthFirst: 1, depthLast: 2 });
    expect(bounded).toMatchObject({ isAncestor: null, deepening: { bound: 2, depths: [1, 2], answered: false } });
    expect(bounded.why).toMatch(/history unknown: .*2 commits.*bound/);

    const deep = mergeBaseAncestry(c, up.mergeBase, { cache, allowFileUrl: true });
    expect(deep).toMatchObject({ isAncestor: true, why: null, deepening: { depths: [64], answered: true } });
    expect(shallowOf(commits)).toEqual([]);

    // With the commits cache gone, the proof makes it again and counts what it fetched:
    // the head's whole history, the merge base and the five commits of the pull request.
    renameSync(commits, join(tempDir("oq-proof-moved-"), "commits.git"));
    const again = prove([c], cache);
    expect(again.cases[0]).toMatchObject({ ok: true, ancestor: { isAncestor: true, deepening: { depths: [64], commitsAdded: 6, answered: true } } });
    const summary = summariseProofs({ suite: "aacr", date: "2026-10-11", shape: "server", proofs: [again], expected: expected([c]), cache });
    expect(summary.cases[0]).toMatchObject({ ok: true, ancestorOfHead: true, deepening: { depths: [64], commitsAdded: 6 } });
    expect(summary.counts).toMatchObject({ proved: 1, failed: 0, deepened: 1, commitsAdded: 6 });
  });
});

describe("a summary of a saved proof folder names the summariser's checkout as the commit the proof ran on", () => {
  it("reads the commit from the folder's proof-run.json, and refuses a folder that records none before writing anything", () => {
    const folder = tempDir("oq-proof-from-");
    mkdirSync(join(folder, "martian-test"));
    writeFileSync(join(folder, "martian-test", "proof.json"), `${JSON.stringify({ version: 1, purpose: "materialise-only", suite: "martian", split: "test", subset: null, shape: "server", startedAt: "1999-01-01T00:00:00.000Z", proved: 0, failed: 0, heldOut: 0, access: [], cases: [] })}\n`);
    // Its date is one no real summary has, so a summary written by mistake
    // is a new file the listing below finds, never an overwrite.
    const index = join(benchRoot, "index", "proof");
    const before = existsSync(index) ? readdirSync(index).sort() : [];
    const summarise = () => spawnSync(process.execPath, [join(benchRoot, "proof.mjs"), "--suite", "martian", "--from", folder], { cwd: repoRoot, encoding: "utf8" });

    let r = summarise();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/proof-run\.json/);
    expect(() => readProofRun(folder)).toThrow(/no commit/);
    writeFileSync(join(folder, "proof-run.json"), `${JSON.stringify({ version: 1, commit: "main", startedAt: "1999-01-01T00:00:00.000Z", shape: "server" })}\n`);
    r = summarise();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no commit/);
    expect(existsSync(index) ? readdirSync(index).sort() : []).toEqual(before);

    const commit = "c".repeat(40);
    writeFileSync(join(folder, "proof-run.json"), `${JSON.stringify({ version: 1, commit, startedAt: "1999-01-01T00:00:00.000Z", shape: "server" })}\n`);
    expect(readProofRun(folder)).toMatchObject({ commit, shape: "server" });
  });
});

// A criss-cross history, as ClickHouse/ClickHouse#80345 has: main and the
// pull request each merged the other's first commit, so the dataset's base
// and the head have two merge bases. `newer` has the later committer date:
// it is the one `git merge-base` prints alone, and the one `git diff
// base...head` diffs against. With `tie`, the two share a committer date,
// and `nonce` goes into the commit messages, which changes every commit id.
function crissCross({ tie = false, nonce = "" } = {}) {
  const dir = join(tempDir("oq-proof-up-"), "widget");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  let day = 0;
  const commit = (...args) => {
    const date = `2025-05-${String(++day).padStart(2, "0")}T12:00:00Z`;
    execFileSync("git", ["-c", "user.name=Upstream", "-c", "user.email=up@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, env: { ...gitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: "ignore" });
    return out(dir, "rev-parse", "HEAD");
  };
  writeFileSync(join(dir, "a.txt"), "root\n");
  git(dir, "add", "-A");
  commit("commit", "-q", "-m", `Root ${nonce}`);
  writeFileSync(join(dir, "main.txt"), "main one\n");
  git(dir, "add", "-A");
  const older = commit("commit", "-q", "-m", `Main one ${nonce}`);
  git(dir, "checkout", "-q", "-b", "feature", "HEAD~1");
  writeFileSync(join(dir, "feature.txt"), "feature one\n");
  git(dir, "add", "-A");
  if (tie) day -= 1;
  const newer = commit("commit", "-q", "-m", `Feature one ${nonce}`);
  commit("merge", "-q", "--no-ff", "-m", "Merge main's first commit", older);
  writeFileSync(join(dir, "feature.txt"), "feature two\n");
  const headSha = commit("commit", "-q", "-am", "Feature two");
  git(dir, "checkout", "-q", "main");
  commit("merge", "-q", "--no-ff", "-m", "Merge the feature's first commit", newer);
  writeFileSync(join(dir, "main.txt"), "main two\n");
  const baseSha = commit("commit", "-q", "-am", "Main two");
  git(dir, "update-ref", "refs/pull/7/head", headSha);
  git(dir, "branch", "-q", "-D", "feature");
  return { dir, baseSha, headSha, older, newer };
}

// A benchmark folder holding an AACR suite of one entry, written the way the
// ingest writes it, and a split that puts it in development.
function oneCaseSuite(up) {
  const root = tempDir("oq-proof-root-");
  const name = "acme__widget-7";
  const entry = { name, id: null, hash: null, status: "usable", excludedWhy: null, prUrl: "https://github.com/acme/widget/pull/7", repo: "acme/widget", cloneUrl: `file://${up.dir}`, prRef: "refs/pull/7/head", baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha: null, language: "Text", changeLines: 2, repoGroup: "acme/widget", licence: MIT, truth: { kind: "lines", accepted: 1, rejected: 0 }, truthHash: "0".repeat(64), matchSignatures: {} };
  entry.hash = entryHash(entry);
  entry.id = realCaseId("aacr", name, entry.hash);
  for (const rel of [SUITES.aacr.cases, SUITES.aacr.split]) mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, SUITES.aacr.cases), `${JSON.stringify({ version: 1, suite: "aacr", cases: [entry] }, null, 2)}\n`);
  writeFileSync(join(root, SUITES.aacr.split), `${JSON.stringify({ version: 1, name: "aacr-v1", suite: "aacr", cases: { dev: [name], test: [] }, subsets: {} }, null, 2)}\n`);
  return { root, name, id: entry.id };
}

describe("a case whose base and head have two merge bases is never built, or is built on a merge base nobody chose", () => {
  it("is refused until the ingest freezes the newest merge base, then builds on it, and the proof records it beside both, in the rule's order", { timeout: 120_000 }, () => {
    const up = crissCross();
    expect(out(up.dir, "merge-base", "--all", up.baseSha, up.headSha).split("\n").sort()).toEqual([up.older, up.newer].sort());
    expect(out(up.dir, "merge-base", up.baseSha, up.headSha)).toBe(up.newer);
    // Newest committer date first.
    const both = [up.newer, up.older];
    const cache = tempDir("oq-proof-cache-");
    const s = oneCaseSuite(up);
    const refused = prove([readCase(s.id, { root: s.root })], cache).cases[0];
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/2 merge bases .*--freeze-merge-base acme__widget-7/);

    const frozen = freezeMergeBase("aacr", s.name, { root: s.root, cache, allowFileUrl: true });
    expect(frozen).toMatchObject({ frozen: true, from: s.id, mergeBaseSha: up.newer, bases: both, rule: MERGE_BASE_RULE });
    const entry = JSON.parse(readFileSync(join(s.root, SUITES.aacr.cases), "utf8")).cases[0];
    expect(entry.mergeBaseSha).toBe(up.newer);
    expect(entry.hash).toBe(entryHash(entry));
    expect(entry.id).toBe(frozen.to);
    // A changed case is a new case: the old id no longer reads.
    expect(frozen.to).not.toBe(s.id);
    expect(() => readCase(s.id, { root: s.root })).toThrow(/a changed case is a new case/);

    const c = readCase(frozen.to, { root: s.root });
    const proof = prove([c], cache);
    expect(proof.cases[0]).toMatchObject({ ok: true, upstream: { mergeBaseSha: up.newer, mergeBaseFrom: "entry", mergeBases: both, mergeBaseRule: MERGE_BASE_RULE, mergeBaseTree: out(up.dir, "rev-parse", `${up.newer}^{tree}`) } });
    const summary = summariseProofs({ suite: "aacr", date: "2026-10-11", shape: "server", proofs: [proof], expected: expected([c]), cache });
    expect(summary.cases[0]).toMatchObject({ ok: true, mergeBaseSha: up.newer, mergeBaseFrom: "entry", mergeBases: both, mergeBaseRule: MERGE_BASE_RULE });
    // Freezing again changes nothing.
    expect(freezeMergeBase("aacr", s.name, { root: s.root, cache, allowFileUrl: true })).toMatchObject({ frozen: false, from: frozen.to, to: frozen.to });
  });

  // Two merge bases with one committer date: `git merge-base` alone prints
  // one of them by the shape of the history, which git does not promise, so
  // two machines could freeze different bases. The rule breaks the tie by
  // the smaller commit id. The history is made again with a new nonce until
  // git's own pick is the larger id, so the test tells the rule from git.
  it("freezes the same merge base on two machines when both merge bases share a committer date: the smaller commit id", { timeout: 120_000 }, () => {
    let up = null;
    for (let nonce = 0; nonce < 32 && up === null; nonce++) {
      const made = crissCross({ tie: true, nonce: String(nonce) });
      if (out(made.dir, "merge-base", made.baseSha, made.headSha) !== [made.older, made.newer].sort()[0]) up = made;
    }
    expect(up, "no nonce in 32 made git pick the larger commit id").not.toBeNull();
    const date = (sha) => out(up.dir, "log", "-1", "--format=%ct", sha);
    expect(date(up.older)).toBe(date(up.newer));
    const ordered = [up.older, up.newer].sort();
    const runs = [0, 1].map(() => {
      const s = oneCaseSuite(up);
      const cache = tempDir("oq-proof-cache-");
      const frozen = freezeMergeBase("aacr", s.name, { root: s.root, cache, allowFileUrl: true });
      const proof = prove([readCase(frozen.to, { root: s.root })], cache);
      return { frozen, upstream: proof.cases[0].upstream };
    });
    for (const { frozen, upstream } of runs) {
      expect(frozen).toMatchObject({ frozen: true, mergeBaseSha: ordered[0], bases: ordered, rule: MERGE_BASE_RULE });
      expect(upstream).toMatchObject({ mergeBaseSha: ordered[0], mergeBaseFrom: "entry", mergeBases: ordered, mergeBaseRule: MERGE_BASE_RULE });
    }
    expect(runs[1].frozen.to).toBe(runs[0].frozen.to);
  });
});
