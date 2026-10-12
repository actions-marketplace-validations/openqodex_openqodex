// Materialising a pull request case (benchmark/lib/materialise.mjs) into the
// repository a review reads, through the clone cache. Every test builds a
// real upstream repository in a temp folder and fetches it over file://, the
// way the materialiser fetches GitHub, so nothing here fakes git (a file
// URL is allowed only because each test asks for it). These failures are
// guarded:
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
// 10. A clone URL that is not the named repository on its pull request's
//    host (user info, another host, another path, plain http, a local
//    path) is fetched.
// 11. A server that ignores the commits-only filter turns the commits cache
//    into a full clone without a word.
// 12. A damaged case repository counts as built.
// 13. A checkout on a case-folding file system keeps one of two files whose
//    names differ only in case, and the shape is still handed out.
// 14. A held-out case is built with no record of the access.
// 15. The tree fetches send no haves, so the server sends each merge base's
//    and each head's whole tree again, and the clone cache keeps about three
//    trees per case (21 GB after 56 AACR cases; issue #160).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { git, gitEnv, listCases, readLock } from "../lib/cases.mjs";
import { caseRepo, materialisePr, prRefusal, verifyCaseRepo } from "../lib/materialise.mjs";
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
    const got = materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true });
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
    const server = materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true });
    expect(server.mergeBaseSha).toBe(up.mergeBase);
    expect(out(server.dir, "rev-parse", "HEAD~1^{tree}")).not.toBe(out(up.dir, "rev-parse", `${up.baseSha}^{tree}`));
    expect(lines(out(server.dir, "diff", "--name-only", "HEAD~1", "HEAD"))).toEqual(PR_FILES);
    const laptop = materialisePr(c, into(), { shape: "laptop", cache, allowFileUrl: true });
    expect(existsSync(join(laptop.dir, "main-later.txt"))).toBe(false);
    expect(readFileSync(join(laptop.dir, "a.txt"), "utf8")).toMatch(/^line 1\n/);
    // A frozen merge base that is not the merge base (here the target's
    // tip) is refused, never built.
    const frozenTip = prCase(up, { mergeBaseSha: up.baseSha });
    expect(() => materialisePr(frozenTip, into(), { shape: "server", cache, allowFileUrl: true })).toThrow(/is not the merge base/);
    const frozenRight = prCase(up, { mergeBaseSha: up.mergeBase });
    expect(materialisePr(frozenRight, into(), { shape: "server", cache, allowFileUrl: true }).mergeBaseSha).toBe(up.mergeBase);
  });

  it("never hands a shallow or partial clone to a review, though the cache itself is shallow", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    for (const shape of ["laptop", "server"]) {
      const { dir } = materialisePr(c, into(), { shape, cache, allowFileUrl: true });
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
    const { dir, base, head } = materialisePr(prCase(up), into(), { shape: "laptop", cache, allowFileUrl: true });
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
    const { dir, base, head } = materialisePr(prCase(up), into(), { shape: "server", cache, allowFileUrl: true });
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
    expect(() => materialisePr(prCase(up, { licence: unknown }), into(), { cache, allowFileUrl: true })).toThrow(/licence unknown/);
    expect(() => materialisePr(prCase(up, { licence: none }), into(), { cache, allowFileUrl: true })).toThrow(/licence none/);
    expect(() => materialisePr(prCase(up, { licence: null }), into(), { cache, allowFileUrl: true })).toThrow(/licence none/);
    expect(() => materialisePr(prCase(up, { status: "excluded" }), into(), { cache, allowFileUrl: true })).toThrow(/excluded/);
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
    expect(() => materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true })).toThrow(/is gone from .* now points at/);
    expect(existsSync(join(cache, "cases", `${c.hash}.git`))).toBe(false);
    // It stops before any tree is downloaded.
    expect(existsSync(join(cache, "repos", "acme__widget.git"))).toBe(false);
  });

  it("finds the merge base on commits alone and downloads the trees of the merge base and the head only", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    materialisePr(prCase(up), into(), { shape: "server", cache, allowFileUrl: true });
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
    const first = materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true });
    expect(first.built).toBe(true);
    const recordPath = join(cache, "cases", `${c.hash}.git`, "materialised.json");
    const bytes = readFileSync(recordPath, "utf8");
    const mtime = statSync(recordPath).mtimeMs;
    const fetchHead = join(cache, "repos", "acme__widget.git", "FETCH_HEAD");
    const fetchedAt = statSync(fetchHead).mtimeMs;
    renameSync(up.dir, `${up.dir}-gone`);
    for (const shape of ["server", "laptop"]) {
      const again = materialisePr(c, into(), { shape, cache, allowFileUrl: true });
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
    expect(materialisePr(rehashed, into(), { shape: "server", cache, allowFileUrl: true }).head).toBe(first.head);
  });

  it("refuses a clone URL that is not the named repository on its pull request's host, before any fetch", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const withUrl = (cloneUrl) => prCase(up, { cloneUrl });
    for (const [url, why] of [
      ["https://github.com@attacker.example/acme/widget.git", /user name or password/],
      ["https://user:secret@github.com/acme/widget.git", /user name or password/],
      ["https://attacker.example/acme/widget.git", /is on attacker\.example, not on github\.com/],
      ["https://github.com/other/widget.git", /is not the repository acme\/widget/],
      ["https://github.com/acme/widget.git/../../other/x", /is not the repository acme\/widget/],
      ["http://github.com/acme/widget.git", /is not https/],
      [`file://${up.dir}`, /local path/],
      ["--upload-pack=touch /tmp/x", /is not a URL/],
    ]) {
      expect(prRefusal(withUrl(url)), url).toMatch(why);
      expect(() => materialisePr(withUrl(url), into(), { cache })).toThrow(why);
    }
    expect(prRefusal(withUrl("https://github.com/acme/widget.git"))).toBeNull();
    expect(prRefusal(withUrl("https://github.com/acme/widget"))).toBeNull();
    expect(prRefusal(withUrl(`file://${up.dir}`), { allowFileUrl: true })).toBeNull();
    expect(existsSync(join(cache, "repos"))).toBe(false);
  });

  it("refuses a server that ignores the commits-only filter, rather than letting the commits cache become a full clone", () => {
    const up = upstream();
    git(up.dir, "config", "uploadpack.allowFilter", "false");
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    expect(() => materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true })).toThrow(/filtering not recognized by server/);
    // The refusal stays: a later call does not build from what was fetched.
    expect(() => materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true })).toThrow(/filtering not recognized by server/);
    expect(existsSync(join(cache, "cases", `${c.hash}.git`))).toBe(false);
  });

  it("counts a case repository as built only with its checked record, and finds a damaged pack", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up);
    materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true });
    const repo = join(cache, "cases", `${c.hash}.git`);
    const recordPath = join(repo, "materialised.json");
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record.fsck).toMatch(/^git fsck --no-dangling: no problems/);
    expect(verifyCaseRepo(c, { cache, allowFileUrl: true }).headTree).toBe(up.headTree);
    // A record without its check is not a built case.
    writeFileSync(recordPath, JSON.stringify({ ...record, fsck: undefined }));
    expect(() => materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true })).toThrow(/damaged/);
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    // A damaged pack keeps readable commits and tree ids, and only fsck sees it.
    const pack = readdirSync(join(repo, "objects", "pack")).find((n) => n.endsWith(".pack"));
    const bytes = readFileSync(join(repo, "objects", "pack", pack));
    for (let i = Math.floor(bytes.length / 2); i < Math.floor(bytes.length / 2) + 64; i++) bytes[i] ^= 0xff;
    chmodSync(join(repo, "objects", "pack", pack), 0o644);
    writeFileSync(join(repo, "objects", "pack", pack), bytes);
    expect(() => verifyCaseRepo(c, { cache, allowFileUrl: true })).toThrow(/fsck/);
  });

  it("refuses a checkout that loses a file on a case-folding file system, in both shapes, naming the colliding paths", () => {
    const dir = join(tempDir("oq-mat-up-"), "fold");
    mkdirSync(dir);
    git(dir, "init", "-q");
    git(dir, "config", "uploadpack.allowFilter", "true");
    writeFileSync(join(dir, "a.txt"), "base\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "Base");
    const baseSha = out(dir, "rev-parse", "HEAD");
    for (const [name, text] of [["Readme.md", "one\n"], ["README.md", "two\n"]]) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: dir, env: gitEnv(), input: text, encoding: "utf8" }).trim();
      git(dir, "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`);
    }
    git(dir, "commit", "-q", "-m", "Two names that differ only in case");
    const headSha = out(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", "refs/pull/7/head", headSha);
    git(dir, "reset", "-q", "--hard", baseSha);
    const up = { dir, baseSha, headSha };
    const cache = tempDir("oq-mat-cache-");
    const probe = tempDir("oq-mat-fold-");
    writeFileSync(join(probe, "x"), "");
    const folds = existsSync(join(probe, "X"));
    for (const shape of ["laptop", "server"]) {
      const build = () => materialisePr(prCase(up), into(), { shape, cache, allowFileUrl: true });
      if (folds) expect(build).toThrow(/README\.md and Readme\.md/);
      else expect(readdirSync(build().dir).filter((n) => n.toLowerCase() === "readme.md").sort()).toEqual(["README.md", "Readme.md"]);
    }
  });

  it("records every build of a held-out case, and refuses one it cannot record", () => {
    const up = sharedUpstream();
    const cache = tempDir("oq-mat-cache-");
    const c = prCase(up, { split: "test" });
    expect(() => materialisePr(c, into(), { cache, allowFileUrl: true })).toThrow(/held out/);
    materialisePr(c, into(), { shape: "server", cache, allowFileUrl: true, heldOut: true });
    materialisePr(c, into(), { shape: "laptop", cache, allowFileUrl: true, heldOut: true });
    const log = lines(readFileSync(join(cache, "held-out-access.log"), "utf8")).map((l) => JSON.parse(l));
    expect(log.map((l) => l.caseId)).toEqual([c.id, c.id]);
    for (const l of log) {
      expect(Number.isNaN(Date.parse(l.at))).toBe(false);
      expect(l.cwd).toBe(process.cwd());
      expect(l).toHaveProperty("argv1");
    }
    const unwritable = tempDir("oq-mat-cache-");
    mkdirSync(join(unwritable, "held-out-access.log"));
    expect(() => materialisePr(c, into(), { cache: unwritable, allowFileUrl: true, heldOut: true })).toThrow(/cannot be recorded/);
    expect(existsSync(join(unwritable, "repos"))).toBe(false);
  });
});

// An upstream whose tree is large next to its changes: 200 files of 4 KB
// that do not compress well, then three pull requests, each branched from
// main and changing one file, with main changing another file after each.
// Every merge base and head shares all but a few files with the others.
function threePrUpstream() {
  const dir = join(tempDir("oq-mat-up-"), "widget");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowFilter", "true");
  const noise = (seed) => {
    let text = "";
    for (let h = seed; text.length < 4096; ) text += h = createHash("sha256").update(h).digest("hex");
    return `${text}\n`;
  };
  for (let i = 0; i < 200; i++) writeFileSync(join(dir, `f${i}.txt`), noise(`f${i}`));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "Files");
  const prs = [];
  for (let k = 1; k <= 3; k++) {
    const mergeBase = out(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", `pr${k}`);
    writeFileSync(join(dir, `f${k}.txt`), noise(`pull request ${k}`));
    git(dir, "commit", "-q", "-am", `Pull request ${k}`);
    const headSha = out(dir, "rev-parse", "HEAD");
    git(dir, "update-ref", `refs/pull/${k}/head`, headSha);
    git(dir, "checkout", "-q", "main");
    git(dir, "branch", "-q", "-D", `pr${k}`);
    writeFileSync(join(dir, `f${100 + k}.txt`), noise(`main ${k}`));
    git(dir, "commit", "-q", "-am", `Main ${k}`);
    prs.push({ k, mergeBase, headSha });
  }
  return { dir, baseSha: out(dir, "rev-parse", "HEAD"), prs, treeObjects: lines(out(dir, "ls-tree", "-r", "-t", `${prs[0].headSha}`)).length + 2 };
}

function threePrCase(up, pr) {
  const hash = createHash("sha256").update(`${up.dir}\0${pr.headSha}`).digest("hex");
  const cloneUrl = `file://${up.dir}`;
  return {
    id: `aacr/acme__widget-${pr.k}@${hash.slice(0, 8)}`,
    suite: "aacr",
    name: `acme__widget-${pr.k}`,
    hash,
    split: "dev",
    status: "usable",
    excludedWhy: null,
    source: { repo: "acme/widget", prUrl: `https://github.com/acme/widget/pull/${pr.k}`, cloneUrl, licence: MIT },
    materialise: { kind: "pr", cloneUrl, prRef: `refs/pull/${pr.k}/head`, baseSha: up.baseSha, headSha: pr.headSha, mergeBaseSha: null },
  };
}

// Bytes of every file under `path`.
function bytesUnder(path) {
  let total = 0;
  for (const e of readdirSync(path, { withFileTypes: true, recursive: true })) if (e.isFile()) total += statSync(join(e.parentPath, e.name)).size;
  return total;
}

// The objects a repository stores, a copy in two packs counted twice.
function storedObjects(repo) {
  const counts = Object.fromEntries(lines(out(repo, "count-objects", "-v")).map((l) => l.split(": ")));
  return Number(counts.count) + Number(counts["in-pack"]);
}

describe("the clone cache keeps each tree about once (#160)", { timeout: 240_000 }, () => {
  it("grows by about one tree per case over three cases of one repository, and a second run adds nothing", () => {
    const up = threePrUpstream();
    const cache = tempDir("oq-mat-cache-");
    const cases = up.prs.map((pr) => threePrCase(up, pr));
    for (const c of cases) expect(caseRepo(c, { cache, allowFileUrl: true }).built).toBe(true);
    const trees = join(cache, "repos", "acme__widget.git");
    const caseRepos = cases.map((c) => join(cache, "cases", `${c.hash}.git`));
    // A case repository holds B and H, which share all but one file: one
    // tree. It holds nothing else of the cache.
    for (const repo of caseRepos) expect(storedObjects(repo)).toBe(lines(out(repo, "rev-list", "--objects", "--all")).length);
    const tree = bytesUnder(join(caseRepos[0], "objects"));
    // Six commits fetched with their trees: the tree cache holds one whole
    // tree and the changes, not six trees.
    expect(storedObjects(trees)).toBeLessThan(1.5 * up.treeObjects);
    expect(bytesUnder(join(trees, "objects"))).toBeLessThan(1.5 * tree);
    // Over three cases, the trees the cache holds are about one per case.
    const held = bytesUnder(join(trees, "objects")) + caseRepos.reduce((n, repo) => n + bytesUnder(join(repo, "objects")), 0);
    expect(held).toBeLessThan((cases.length + 1) * 1.25 * tree);

    // A second run adds nothing.
    const before = bytesUnder(cache);
    for (const c of cases) expect(caseRepo(c, { cache, allowFileUrl: true }).built).toBe(false);
    expect(bytesUnder(cache)).toBe(before);
    // With the case repositories moved away, they are built again from the
    // tree cache, with nothing fetched.
    const fetchedAt = statSync(join(trees, "FETCH_HEAD")).mtimeMs;
    const treeBytes = bytesUnder(trees);
    renameSync(join(cache, "cases"), join(tempDir("oq-mat-moved-"), "cases"));
    for (const c of cases) expect(caseRepo(c, { cache, allowFileUrl: true }).built).toBe(true);
    expect(statSync(join(trees, "FETCH_HEAD")).mtimeMs).toBe(fetchedAt);
    expect(bytesUnder(trees)).toBe(treeBytes);
  });

  it("reuses the trees of a tree cache filled before the fix, which holds its commits without refs", () => {
    const up = threePrUpstream();
    const cache = tempDir("oq-mat-cache-");
    const cases = up.prs.map((pr) => threePrCase(up, pr));
    caseRepo(cases[0], { cache, allowFileUrl: true });
    const trees = join(cache, "repos", "acme__widget.git");
    for (const ref of lines(out(trees, "for-each-ref", "--format=%(refname)"))) git(trees, "update-ref", "-d", ref);
    expect(out(trees, "for-each-ref")).toBe("");
    for (const c of cases.slice(1)) caseRepo(c, { cache, allowFileUrl: true });
    expect(storedObjects(trees)).toBeLessThan(1.5 * up.treeObjects);
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
