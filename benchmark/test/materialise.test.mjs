// Materialising a pull request case (benchmark/lib/materialise.mjs) into the
// repository a review reads, through the clone cache. Every test builds a
// real upstream repository in a temp folder and fetches it over file://, the
// way the materialiser fetches GitHub, so nothing here fakes git. Seven
// failures are guarded:
//
// 1. The built head differs from the pull request head, so AACR's lines
//    point at other code (line endings renormalised, an export-ignore file
//    left out, a committed but ignored file lost, a mode or a link changed).
// 2. The target branch's tip is used as the base after the target moved, so
//    the change holds the target's later commits reversed.
// 3. A shallow or partial clone reaches reviewChange, which then cannot
//    prove the merge base or read every file.
// 4. The laptop shape loses a file the pull request deleted (or added, or
//    changed only in mode).
// 5. The server shape is not exactly the base and the head as two commits.
// 6. A case whose licence is not usable is fetched before it is refused.
// 7. A second call on a built case fetches or builds again.
// 8. A pull request pushed over after the dataset was made is built from
//    its pull request ref's newer tip, a change AACR's lines do not belong
//    to (AACR's ClickHouse/ClickHouse#74070 is one).
// 9. Finding the merge base downloads the trees and files of every commit
//    between the tips (FreeCAD/FreeCAD#19411 took 1.7 GB before it was
//    stopped).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, gitEnv, listCases, readLock } from "../lib/cases.mjs";
import { materialisePr } from "../lib/materialise.mjs";
import { materialise, readCase } from "../lib/suites.mjs";
import { removeTempDirs, tempDir } from "../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const out = (dir, ...args) => git(dir, ...args).trim();
const lines = (text) => text.split("\n").filter(Boolean);

// git with input on stdin, for fast-import.
function gitInput(dir, input, ...args) {
  return execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd: dir, env: gitEnv(), input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

// An upstream repository shaped like a real pull request:
// - a long history on main (longer than the cache deepens), then the files a
//   naive rebuild would get wrong: a CRLF file committed before a
//   `* text=auto` rule, a file marked export-ignore, a committed file that
//   .gitignore ignores, a submodule entry, and a script without its mode;
// - the merge base M adds the .gitattributes;
// - the pull request (two commits, reachable only from refs/pull/7/head)
//   edits a.txt, deletes old.txt, adds new.txt and a link, makes run.sh
//   executable and edits the ignored kept.log;
// - main then moves on (main-later.txt and an edit to a.txt's first line),
//   so the dataset's base commit, main's tip, is not the merge base.
function upstream() {
  const dir = join(tempDir("oq-mat-up-"), "widget");
  mkdirSync(dir);
  git(dir, "init", "-q");
  // GitHub serves partial clones; a local upstream does once allowed to.
  git(dir, "config", "uploadpack.allowFilter", "true");
  let stream = "";
  for (let n = 1; n <= 300; n++) stream += `commit refs/heads/main\ncommitter Upstream <up@example.invalid> ${1700000000 + n} +0000\ndata 3\nh${n % 10}\nM 644 inline history.txt\ndata ${String(n).length + 1}\n${n}\n\n`;
  gitInput(dir, stream, "fast-import", "--quiet");
  git(dir, "reset", "-q", "--hard", "main");
  writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
  writeFileSync(join(dir, "a.txt"), `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
  writeFileSync(join(dir, "old.txt"), "to be deleted\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho run\n");
  writeFileSync(join(dir, "secret.cfg"), "kept out of archives\n");
  writeFileSync(join(dir, ".gitignore"), "*.log\n");
  writeFileSync(join(dir, "kept.log"), "committed although ignored\n");
  git(dir, "add", "-A");
  git(dir, "add", "-f", "kept.log");
  git(dir, "update-index", "--add", "--cacheinfo", `160000,${"5".repeat(40)},vendor/sub`);
  // An empty folder is a submodule not checked out, which `add -A` keeps.
  mkdirSync(join(dir, "vendor", "sub"), { recursive: true });
  git(dir, "commit", "-q", "-m", "Files");
  writeFileSync(join(dir, ".gitattributes"), "* text=auto\nsecret.cfg export-ignore\n");
  git(dir, "add", ".gitattributes");
  git(dir, "commit", "-q", "-m", "Attributes");
  const mergeBase = out(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), readFileSync(join(dir, "a.txt"), "utf8").replace("line 5\n", "line five\n"));
  git(dir, "rm", "-q", "old.txt");
  writeFileSync(join(dir, "new.txt"), "added by the pull request\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Feature one");
  symlinkSync("a.txt", join(dir, "link"));
  chmodSync(join(dir, "run.sh"), 0o755);
  writeFileSync(join(dir, "kept.log"), "committed although ignored, and edited\n");
  git(dir, "add", "-A", ".", "link");
  git(dir, "add", "-f", "kept.log");
  git(dir, "commit", "-q", "-m", "Feature two");
  const headSha = out(dir, "rev-parse", "HEAD");

  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "main-later.txt"), "main moved on\n");
  writeFileSync(join(dir, "a.txt"), readFileSync(join(dir, "a.txt"), "utf8").replace("line 1\n", "line one\n"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Main later");
  const baseSha = out(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/pull/7/head", headSha);
  git(dir, "branch", "-q", "-D", "feature");
  return { dir, baseSha, headSha, mergeBase, baseTree: out(dir, "rev-parse", `${mergeBase}^{tree}`), headTree: out(dir, "rev-parse", `${headSha}^{tree}`) };
}

// One upstream for the tests that only read it; a test that moves the
// upstream away builds its own.
let shared = null;
const sharedUpstream = () => (shared ??= upstream());

const MIT = { spdx: "MIT", chosen: "MIT", class: "permissive", file: "LICENSE", fileSha256: null, at: "the default branch", source: "the GitHub licence API", use: "local review and scoring", excerpts: "full" };

// A case in the shape lib/suites.mjs readCase returns for an AACR entry.
function prCase(up, { licence = MIT, status = "usable", split = "dev", mergeBaseSha = null, cloneUrl = `file://${up.dir}` } = {}) {
  const hash = createHash("sha256").update(`${up.dir}\0${up.headSha}\0${mergeBaseSha}`).digest("hex");
  return {
    id: `aacr/acme__widget-7@${hash.slice(0, 8)}`,
    suite: "aacr",
    name: "acme__widget-7",
    hash,
    split,
    status,
    excludedWhy: status === "usable" ? null : "excluded for this test",
    source: { repo: "acme/widget", prUrl: "https://github.com/acme/widget/pull/7", cloneUrl, licence },
    materialise: { kind: "pr", cloneUrl, prRef: "refs/pull/7/head", baseSha: up.baseSha, headSha: up.headSha, mergeBaseSha },
  };
}

const into = () => join(tempDir("oq-mat-into-"), "repo");
const PR_FILES = ["a.txt", "kept.log", "link", "new.txt", "old.txt", "run.sh"];

// The tree a review sees in a repository: HEAD's tree with every working
// tree change added, untracked files included, on a copy of the index.
function seenTree(repo) {
  const index = join(tempDir("oq-mat-index-"), "index");
  const env = { ...gitEnv(), GIT_INDEX_FILE: index };
  const run = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run("read-tree", "HEAD");
  run("add", "-A");
  return run("write-tree");
}

// Each test builds, fetches and clones real repositories with a few dozen
// git commands; a busy machine takes several times the default 30 seconds.
describe("materialising a pull request case", { timeout: 120_000 }, () => {
  it("builds a base and a head whose trees are the pull request's own, so AACR's lines point at the same code", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    const got = materialisePr(c, into(), { shape: "server", cache });
    const record = JSON.parse(readFileSync(join(cache, "cases", `${c.hash}.git`, "materialised.json"), "utf8"));
    expect(record.upstream.headTree).toBe(up.headTree);
    expect(record.upstream.mergeBaseTree).toBe(up.baseTree);
    expect(record.headTree).toBe(up.headTree);
    expect(record.baseTree).toBe(up.baseTree);
    expect(out(got.dir, "rev-parse", "HEAD^{tree}")).toBe(up.headTree);
    expect(out(got.dir, "rev-parse", "HEAD~1^{tree}")).toBe(up.baseTree);
    // The files the reviewer reads are the head's bytes: CRLF kept, the
    // export-ignore file and the ignored file present, the link a link.
    expect(readFileSync(join(got.dir, "crlf.txt"), "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
    expect(existsSync(join(got.dir, "secret.cfg"))).toBe(true);
    expect(readFileSync(join(got.dir, "kept.log"), "utf8")).toBe("committed although ignored, and edited\n");
    expect(statSync(join(got.dir, "run.sh")).mode & 0o111).not.toBe(0);
    expect(seenTree(got.dir)).toBe(up.headTree);
  });

  it("uses the merge base, never the target branch's tip, as the base after the target moved", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    const server = materialisePr(c, into(), { shape: "server", cache });
    expect(server.mergeBaseSha).toBe(up.mergeBase);
    expect(out(server.dir, "rev-parse", "HEAD~1^{tree}")).not.toBe(out(up.dir, "rev-parse", `${up.baseSha}^{tree}`));
    expect(lines(out(server.dir, "diff", "--name-only", "HEAD~1", "HEAD"))).toEqual(PR_FILES);
    const laptop = materialisePr(c, into(), { shape: "laptop", cache });
    expect(existsSync(join(laptop.dir, "main-later.txt"))).toBe(false);
    expect(readFileSync(join(laptop.dir, "a.txt"), "utf8")).toMatch(/^line 1\n/);
    // A frozen merge base that is not the merge base (here the target's
    // tip) is refused, never built.
    const frozenTip = prCase(up, { mergeBaseSha: up.baseSha });
    expect(() => materialisePr(frozenTip, into(), { shape: "server", cache })).toThrow(/is not the merge base/);
    const frozenRight = prCase(up, { mergeBaseSha: up.mergeBase });
    expect(materialisePr(frozenRight, into(), { shape: "server", cache }).mergeBaseSha).toBe(up.mergeBase);
  });

  it("never hands a shallow or partial clone to a review, though the cache itself is shallow", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    for (const shape of ["laptop", "server"]) {
      const { dir } = materialisePr(c, into(), { shape, cache });
      expect(out(dir, "rev-parse", "--is-shallow-repository")).toBe("false");
      expect(existsSync(join(dir, ".git", "objects", "info", "alternates"))).toBe(false);
      const promisor = spawnSync("git", ["config", "--get-regexp", "promisor|partialclone"], { cwd: dir, env: gitEnv(), encoding: "utf8" });
      expect([promisor.status, promisor.stdout]).toEqual([1, ""]);
      expect(out(dir, "rev-list", "--objects", "--all", "--missing=print").split("\n").filter((l) => l.startsWith("?"))).toEqual([]);
      expect(out(dir, "remote")).toBe("");
    }
    const caseRepo = join(cache, "cases", `${c.hash}.git`);
    expect(out(caseRepo, "rev-parse", "--is-shallow-repository")).toBe("false");
    expect(existsSync(join(caseRepo, "objects", "info", "alternates"))).toBe(false);
    expect(out(join(cache, "repos", "acme__widget.git"), "rev-parse", "--is-shallow-repository")).toBe("true");
  });

  it("laptop shape: the base committed and the whole change in the working tree, a deleted file deleted and new files untracked", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const { dir, base, head } = materialisePr(prCase(up), into(), { shape: "laptop", cache });
    expect(out(dir, "rev-parse", "HEAD")).toBe(base);
    expect(out(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(out(dir, "rev-parse", "HEAD^{tree}")).toBe(up.baseTree);
    expect(lines(git(dir, "status", "--porcelain", "-uall")).sort()).toEqual([" D old.txt", " M a.txt", " M kept.log", " M run.sh", "?? link", "?? new.txt"]);
    expect(existsSync(join(dir, "old.txt"))).toBe(false);
    expect(seenTree(dir)).toBe(up.headTree);
    expect(out(dir, "rev-parse", `${head}^{tree}`)).toBe(up.headTree);
  });

  it("server shape: exactly two commits, the base then the head, and nothing uncommitted", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const { dir, base, head } = materialisePr(prCase(up), into(), { shape: "server", cache });
    expect(out(dir, "rev-list", "--count", "HEAD")).toBe("2");
    expect(out(dir, "rev-parse", "HEAD")).toBe(head);
    expect(out(dir, "rev-parse", "HEAD^")).toBe(base);
    expect(out(dir, "rev-list", "--count", "--all")).toBe("2");
    expect(git(dir, "status", "--porcelain", "-uall")).toBe("");
  });

  it("refuses a case whose licence is unknown or none, or that is excluded, before anything is fetched", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const unknown = { ...MIT, spdx: "NOASSERTION", chosen: null, class: "unknown", excerpts: "omit" };
    const none = { ...MIT, spdx: null, chosen: null, class: "none", file: null, excerpts: "omit" };
    expect(() => materialisePr(prCase(up, { licence: unknown }), into(), { cache })).toThrow(/licence unknown/);
    expect(() => materialisePr(prCase(up, { licence: none }), into(), { cache })).toThrow(/licence none/);
    expect(() => materialisePr(prCase(up, { licence: null }), into(), { cache })).toThrow(/licence none/);
    expect(() => materialisePr(prCase(up, { status: "excluded" }), into(), { cache })).toThrow(/excluded/);
    expect(existsSync(join(cache, "repos"))).toBe(false);
    expect(existsSync(join(cache, "cases"))).toBe(false);
  });

  it("refuses a pull request whose head was pushed over upstream, never building the pull request ref's newer tip", () => {
    const up = upstream();
    git(up.dir, "checkout", "-q", "-b", "over", up.mergeBase);
    writeFileSync(join(up.dir, "new.txt"), "a later version of the pull request\n");
    git(up.dir, "add", "-A");
    git(up.dir, "commit", "-q", "-m", "Pushed over");
    git(up.dir, "update-ref", "refs/pull/7/head", out(up.dir, "rev-parse", "HEAD"));
    git(up.dir, "checkout", "-q", "main");
    git(up.dir, "branch", "-q", "-D", "over");
    git(up.dir, "reflog", "expire", "--expire=now", "--all");
    git(up.dir, "gc", "-q", "--prune=now");
    expect(spawnSync("git", ["cat-file", "-e", `${up.headSha}^{commit}`], { cwd: up.dir, env: gitEnv() }).status).not.toBe(0);
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    expect(() => materialisePr(c, into(), { shape: "server", cache })).toThrow(/is gone from .* now points at/);
    expect(existsSync(join(cache, "cases", `${c.hash}.git`))).toBe(false);
    // It stops before any tree is downloaded.
    expect(existsSync(join(cache, "repos", "acme__widget.git"))).toBe(false);
  });

  it("finds the merge base on commits alone and downloads the trees of the merge base and the head only", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    materialisePr(prCase(up), into(), { shape: "server", cache });
    const types = (repo) => lines(out(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)")).reduce((n, t) => ({ ...n, [t]: (n[t] ?? 0) + 1 }), {});
    const commits = types(join(cache, "repos", "acme__widget.commits.git"));
    expect(Object.keys(commits)).toEqual(["commit"]);
    expect(commits.commit).toBeGreaterThan(3);
    const trees = join(cache, "repos", "acme__widget.git");
    expect(types(trees).commit).toBe(2);
    for (const sha of [up.mergeBase, up.headSha]) expect(spawnSync("git", ["cat-file", "-e", `${sha}^{tree}`], { cwd: trees, env: gitEnv() }).status).toBe(0);
  });

  it("does nothing the second time: no fetch and no rebuild, even with the upstream gone", () => {
    const up = upstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    const first = materialisePr(c, into(), { shape: "server", cache });
    expect(first.built).toBe(true);
    const recordPath = join(cache, "cases", `${c.hash}.git`, "materialised.json");
    const bytes = readFileSync(recordPath, "utf8");
    const mtime = statSync(recordPath).mtimeMs;
    const fetchHead = join(cache, "repos", "acme__widget.git", "FETCH_HEAD");
    const fetchedAt = statSync(fetchHead).mtimeMs;
    renameSync(up.dir, `${up.dir}-gone`);
    for (const shape of ["server", "laptop"]) {
      const again = materialisePr(c, into(), { shape, cache });
      expect(again.built).toBe(false);
      expect(again.base).toBe(first.base);
      expect(again.head).toBe(first.head);
    }
    expect(readFileSync(recordPath, "utf8")).toBe(bytes);
    expect(statSync(recordPath).mtimeMs).toBe(mtime);
    expect(statSync(fetchHead).mtimeMs).toBe(fetchedAt);
    // The same pull request under a new case hash builds from the cache's
    // fetched commits, so it needs no upstream either.
    const rehashed = { ...c, hash: "c".repeat(64), id: "aacr/acme__widget-7@cccccccc" };
    expect(materialisePr(rehashed, into(), { shape: "server", cache }).head).toBe(first.head);
  });
});

describe("the one case interface", () => {
  it("materialises a planted case in either shape, the server shape as two commits", () => {
    const name = listCases()[0];
    const c = readCase(`planted/${name}@${readCaseHash(name)}`);
    const laptop = materialise(c, into(), { shape: "laptop" });
    expect(out(laptop.dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(laptop.dir, "status", "--porcelain")).not.toBe("");
    const server = materialise(c, into(), { shape: "server" });
    expect(out(server.dir, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(server.dir, "status", "--porcelain", "-uall")).toBe("");
    expect(seenTree(laptop.dir)).toBe(out(server.dir, "rev-parse", "HEAD^{tree}"));
  });
});

const readCaseHash = (name) => readLock().cases[name].hash.slice(0, 8);
