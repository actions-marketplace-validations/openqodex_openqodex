// Ways the change source could fail, each one a test below:
// 1. A modified tracked file or a new untracked file is missing from the change.
// 2. A gitignored file shows up as changed.
// 3. Commits made but not yet pushed are missed because the base is HEAD
//    instead of the merge-base with the upstream.
// 4. Without an upstream, the default branch on the remote is not used.
// 5. --uncommitted still includes committed work.
// 6. A deleted file is handed to scanners, or a rename shows as add plus delete.
// 7. A binary file change does not move the change id.
// 8. A path with spaces or non-ASCII characters comes back C-quoted.
// 9. A repo with no commits fails instead of diffing against the empty tree.
// 10. Exclude globs leak into files, coverage, the diff or the stats.
// 11. The id moves between two runs on the same content, or does not move
//     after an edit, including an edit to a file past the 5 MB diff cap.
// 12. Coverage counts context lines or old-side lines as changed.
// 13. Anything is written inside .git: the index bytes change, git status
//     changes, a file appears in .git, or the run fails with .git read-only.
// 14. The tool's own .openqodex/ folder is reported as part of the change.
// 15. A folder that is not in a git repository is not reported as such.
// 16. A huge change (a forgotten dump or node_modules) is buffered whole or
//     expanded into per-line coverage instead of being left out.
// 17. A type change (symlink to regular file) gives two patch blocks for one
//     file and breaks the file-to-patch pairing.
// 18. A configured clean filter runs during the temp add and writes inside
//     .git.
// 19. Inherited settings (GIT_DIFF_OPTS, diff.interHunkContext,
//     diff.ignoreSubmodules, diff.submodule) widen coverage, hide a change
//     or change the patch shape.
// 20. A partial clone fetches a missing object during the review.
// 21. A repo path with a colon breaks the alternate object folder.
// 22. Without an upstream, review.default_base is ignored in favour of the
//     remote's default branch, a branch that exists only on origin is not
//     found, or a name that exists nowhere silently falls back.
// 23. A file rewritten at the same size in the same second the index was
//     written is missed, because the temp copy of the index carries a later
//     time and git then trusts the file's stat over its content.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COVERAGE_MAX_LINES, DIFF_CAP_BYTES, findRepoRoot, getChange } from "../src/change.js";
import { OpenQodexError } from "../src/types.js";

const roots: string[] = [];
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };

beforeAll(() => {
  // Tests run against git's defaults, not the developer's own settings.
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterAll(() => {
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = savedEnv.system;
  for (const r of roots) {
    execFileSync("chmod", ["-R", "u+w", r]);
    rmSync(r, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "oq-change-test-"));
  roots.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function write(repo: string, path: string, content: string | Buffer): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function newRepo(dir = tempDir()): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

function lines(n: number, prefix = "line"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
}

// A repo with one commit holding a.ts (10 lines) and a .gitignore.
function seeded(): string {
  const repo = newRepo();
  write(repo, "a.ts", lines(10));
  write(repo, ".gitignore", "ignored.log\n");
  commitAll(repo, "base");
  return repo;
}

// A bare remote with main pushed, the clone tracking it.
function withUpstream(): { repo: string; baseSha: string } {
  const bare = tempDir();
  git(bare, "init", "-q", "--bare", "-b", "main");
  const repo = seeded();
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, baseSha: git(repo, "rev-parse", "HEAD").trim() };
}

function paths(change: { files: { path: string }[] }): string[] {
  return change.files.map((f) => f.path).sort();
}

// Every file in .git: path, size and content hash.
function gitTreeFingerprint(repo: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${relative(repo, p)} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(join(repo, ".git"));
  return out.sort().join("\n");
}

function indexHash(repo: string): string {
  return createHash("sha256").update(readFileSync(join(repo, ".git", "index"))).digest("hex");
}

describe("findRepoRoot", () => {
  it("returns the top folder from inside a subfolder", async () => {
    const repo = seeded();
    write(repo, "sub/x.ts", "x\n");
    const root = await findRepoRoot(join(repo, "sub"));
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe(lines(10));
  });

  it("says plainly when the folder is not in a git repository", async () => {
    const dir = tempDir();
    await expect(findRepoRoot(dir)).rejects.toThrow(OpenQodexError);
    await expect(findRepoRoot(dir)).rejects.toThrow("not a git repository");
  });
});

describe("getChange", () => {
  it("finds a modified tracked file and a new untracked file, not an ignored one", async () => {
    const repo = seeded();
    write(repo, "a.ts", lines(10).replace("line 3\n", "line three\n"));
    write(repo, "new.ts", "one\ntwo\n");
    write(repo, "ignored.log", "noise\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.baseRef).toBe("HEAD");
    expect(paths(c)).toEqual(["a.ts", "new.ts"]);
    expect(c.files.find((f) => f.path === "new.ts")?.status).toBe("added");
    expect(c.files.find((f) => f.path === "a.ts")?.status).toBe("modified");
    expect(c.stats).toEqual({ files: 2, additions: 3, deletions: 1 });
    expect(c.diff).toContain("+line three");
    expect(c.diff).toContain(" line 2"); // the brief's diff carries context
  });

  it("counts only added or changed lines as covered", async () => {
    const repo = seeded();
    const edited = lines(10).replace("line 3\n", "line three\n").replace("line 8\n", "") + "line 11\n";
    write(repo, "a.ts", edited);
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    // line 3 changed; line 8 deleted (no new-side line); line 11 appended at new line 10
    expect(c.coverage.get("a.ts")).toEqual(new Set([3, 10]));
  });

  it("includes commits not yet pushed, against the upstream", async () => {
    const { repo, baseSha } = withUpstream();
    write(repo, "committed.ts", "c\n");
    commitAll(repo, "local work");
    write(repo, "a.ts", lines(11));
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.baseRef).toBe("origin/main");
    expect(c.baseSha).toBe(baseSha);
    expect(paths(c)).toEqual(["a.ts", "committed.ts"]);
  });

  it("falls back to the remote's default branch without an upstream", async () => {
    const { repo, baseSha } = withUpstream();
    git(repo, "remote", "set-head", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "f.ts", "f\n");
    commitAll(repo, "feature work");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.baseRef).toBe("origin/main");
    expect(c.baseSha).toBe(baseSha);
    expect(paths(c)).toEqual(["f.ts"]);
  });

  it("uses review.default_base over the remote's default branch, finding it on origin when it is not local", async () => {
    const { repo } = withUpstream();
    git(repo, "remote", "set-head", "origin", "main");
    git(repo, "checkout", "-q", "-b", "develop");
    write(repo, "on-develop.ts", "d\n");
    commitAll(repo, "develop work");
    const developSha = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "push", "-q", "origin", "develop");
    git(repo, "checkout", "-q", "main");
    git(repo, "branch", "-q", "-D", "develop");
    git(repo, "checkout", "-q", "-b", "feature", developSha);
    write(repo, "f.ts", "f\n");
    commitAll(repo, "feature work");

    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [], defaultBase: "develop" });
    expect(c.baseRef).toBe("origin/develop");
    expect(c.baseSha).toBe(developSha);
    expect(paths(c)).toEqual(["f.ts"]);

    git(repo, "branch", "-q", "develop", developSha);
    expect((await getChange({ repoRoot: repo, scope: {}, exclude: [], defaultBase: "develop" })).baseRef).toBe("develop");
    expect((await getChange({ repoRoot: repo, scope: {}, exclude: [], defaultBase: null })).baseRef).toBe("origin/main");
    await expect(getChange({ repoRoot: repo, scope: {}, exclude: [], defaultBase: "release" })).rejects.toThrow(
      /^review\.default_base: release is not a ref here or a branch on origin/,
    );
  });

  it("reviews only the working tree with uncommitted, after committing half", async () => {
    const { repo } = withUpstream();
    write(repo, "first.ts", "1\n");
    commitAll(repo, "first half");
    write(repo, "second.ts", "2\n");
    const all = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    const wt = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    expect(paths(all)).toEqual(["first.ts", "second.ts"]);
    expect(wt.baseRef).toBe("HEAD");
    expect(paths(wt)).toEqual(["second.ts"]);
  });

  it("uses an explicit base as the point the branch left it", async () => {
    const repo = seeded();
    const start = git(repo, "rev-parse", "HEAD").trim();
    git(repo, "checkout", "-q", "-b", "feature");
    write(repo, "f.ts", "f\n");
    commitAll(repo, "feature");
    git(repo, "checkout", "-q", "main");
    write(repo, "later-on-main.ts", "m\n");
    commitAll(repo, "main moved on");
    git(repo, "checkout", "-q", "feature");
    const c = await getChange({ repoRoot: repo, scope: { base: "main" }, exclude: [] });
    expect(c.baseRef).toBe("main");
    expect(c.baseSha).toBe(start);
    expect(paths(c)).toEqual(["f.ts"]);
    await expect(getChange({ repoRoot: repo, scope: { base: "no-such-ref" }, exclude: [] })).rejects.toThrow(
      "base not found: no-such-ref",
    );
  });

  it("reports a deleted file without handing it to scanners, and a rename as one entry", async () => {
    const repo = seeded();
    write(repo, "gone.ts", "bye\n");
    write(repo, "old-name.ts", lines(20, "keep"));
    commitAll(repo, "more");
    rmSync(join(repo, "gone.ts"));
    git(repo, "mv", "old-name.ts", "new-name.ts");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.files.find((f) => f.path === "gone.ts")).toMatchObject({ status: "deleted", oldPath: null });
    expect(c.files.find((f) => f.path === "new-name.ts")).toMatchObject({ status: "renamed", oldPath: "old-name.ts" });
    expect(paths(c)).toEqual(["gone.ts", "new-name.ts"]);
    expect(c.changedPaths.sort()).toEqual(["new-name.ts"]);
    expect(c.coverage.has("gone.ts")).toBe(false);
    expect(c.coverage.get("new-name.ts")).toBeUndefined(); // a pure rename changes no line
  });

  it("flags a binary file and moves the id when its bytes change", async () => {
    const repo = seeded();
    write(repo, "img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
    const first = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(first.files.find((f) => f.path === "img.bin")?.binary).toBe(true);
    expect(first.changedPaths).toContain("img.bin");
    expect(first.coverage.get("img.bin")).toBeUndefined();
    write(repo, "img.bin", Buffer.from([0, 1, 2, 3, 0, 254]));
    const second = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(second.id).not.toBe(first.id);
  });

  it("returns real paths for names with spaces and non-ASCII characters", async () => {
    const repo = seeded();
    const odd = "dir with space/café menu.ts";
    write(repo, odd, "a\nb\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(paths(c)).toEqual([odd]);
    expect(c.changedPaths).toEqual([odd]);
    expect(c.coverage.get(odd)).toEqual(new Set([1, 2]));
  });

  it("diffs a repo with no commits against the empty tree", async () => {
    const repo = newRepo();
    write(repo, "first.ts", "x\ny\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.baseRef).toBe("empty tree");
    expect(paths(c)).toEqual(["first.ts"]);
    expect(c.coverage.get("first.ts")).toEqual(new Set([1, 2]));
    const wt = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    expect(paths(wt)).toEqual(["first.ts"]);
  });

  it("applies exclude globs to files, coverage, diff and stats", async () => {
    const repo = seeded();
    write(repo, "vendor/lib/x.js", "v\n");
    write(repo, "app.min.js", "m\n");
    write(repo, "src/keep.ts", "k\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: ["vendor/**", "*.min.js"] });
    expect(paths(c)).toEqual(["src/keep.ts"]);
    expect(c.changedPaths).toEqual(["src/keep.ts"]);
    expect([...c.coverage.keys()]).toEqual(["src/keep.ts"]);
    expect(c.diff).not.toContain("vendor/");
    expect(c.diff).not.toContain("app.min.js");
    expect(c.stats).toEqual({ files: 1, additions: 1, deletions: 0 });
  });

  it("still works when the repo's own .gitignore lists .openqodex and the folder exists", async () => {
    // Failure this guards: git refuses a pathspec that names an ignored path,
    // so the second run in such a repo died with "paths are ignored".
    const repo = seeded();
    write(repo, ".gitignore", ".openqodex/\n");
    commitAll(repo, "ignore the report folder");
    write(repo, ".openqodex/reviews/one/report.md", "old report\n");
    write(repo, "src/new.ts", "export const n = 1;\n");
    const change = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    expect(paths(change)).toEqual(["src/new.ts"]);
  });

  it("never counts its own .openqodex folder", async () => {
    const repo = seeded();
    write(repo, ".openqodex/reviews/x/report.md", "r\n");
    write(repo, "b.ts", "b\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(paths(c)).toEqual(["b.ts"]);
  });

  it("keeps the id stable on the same content and moves it after any edit", async () => {
    const repo = seeded();
    write(repo, "b.ts", "b\n");
    const one = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    const two = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(two.id).toBe(one.id);
    expect(one.shortId).toBe(one.id.slice(0, 12));
    expect(one.id).toMatch(/^[0-9a-f]{64}$/);
    write(repo, "b.ts", "b2\n");
    const three = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(three.id).not.toBe(one.id);
  });

  it("leaves files past the diff cap out whole, and still moves the id when they change", async () => {
    const repo = seeded();
    write(repo, "a.ts", lines(10).replace("line 1\n", "line one\n"));
    const big = "x".repeat(99) + "\n";
    const bigContent = big.repeat(Math.ceil(DIFF_CAP_BYTES / big.length) + 10);
    write(repo, "zz-big.txt", bigContent);
    const first = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(first.notReviewed).toEqual(["zz-big.txt"]);
    expect(first.diff).toContain("line one");
    expect(first.diff).not.toContain("zz-big.txt");
    expect(Buffer.byteLength(first.diff)).toBeLessThanOrEqual(DIFF_CAP_BYTES);
    expect(first.changedPaths).toContain("zz-big.txt");
    write(repo, "zz-big.txt", bigContent + "one more line\n");
    const second = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(second.diff).toBe(first.diff);
    expect(second.id).not.toBe(first.id);
  });

  it("writes nothing inside .git", async () => {
    const repo = seeded();
    write(repo, "a.ts", lines(12));
    write(repo, "untracked.ts", "u\n");
    git(repo, "status", "--porcelain");
    const before = gitTreeFingerprint(repo);
    await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(gitTreeFingerprint(repo)).toBe(before);
  });

  it("works with .git read-only and leaves the index and status unchanged", async () => {
    const repo = seeded();
    write(repo, "a.ts", lines(12));
    write(repo, "untracked.ts", "u\n");
    write(repo, "staged.ts", "s\n");
    git(repo, "add", "staged.ts");
    const statusBefore = git(repo, "status", "--porcelain");
    const indexBefore = indexHash(repo);
    execFileSync("chmod", ["-R", "a-w", join(repo, ".git")]);
    let c;
    try {
      c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    } finally {
      execFileSync("chmod", ["-R", "u+w", join(repo, ".git")]);
    }
    expect(paths(c)).toEqual(["a.ts", "staged.ts", "untracked.ts"]);
    expect(indexHash(repo)).toBe(indexBefore);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
  });

  it("leaves a change past the coverage line cap out of coverage and the brief", async () => {
    const repo = seeded();
    write(repo, "a.ts", lines(10).replace("line 2\n", "line two\n"));
    write(repo, "dump.sql", "x\n".repeat(COVERAGE_MAX_LINES + 1));
    write(repo, "zz.ts", "z\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.notReviewed).toEqual(["dump.sql"]);
    expect(c.coverage.has("dump.sql")).toBe(false);
    expect(c.coverage.get("a.ts")).toEqual(new Set([2]));
    expect(c.coverage.get("zz.ts")).toEqual(new Set([1]));
    expect(c.diff).not.toContain("dump.sql");
    expect(c.changedPaths).toContain("dump.sql");
    expect(c.stats.additions).toBe(COVERAGE_MAX_LINES + 3);
  });

  it("leaves out a single line too long for the brief without holding it", async () => {
    const repo = seeded();
    write(repo, "app.min.js", "y".repeat(DIFF_CAP_BYTES + 10) + "\n");
    write(repo, "b.ts", "b\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.notReviewed).toEqual(["app.min.js"]);
    expect(c.coverage.get("app.min.js")).toEqual(new Set([1]));
    expect(c.diff).toContain("+b");
    expect(c.diff).not.toContain("yyyy");
  });

  it("handles a tracked symlink replaced by a regular file", async () => {
    const repo = seeded();
    symlinkSync("a.ts", join(repo, "link"));
    commitAll(repo, "link");
    rmSync(join(repo, "link"));
    write(repo, "link", "plain\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.files).toEqual([{ path: "link", status: "modified", oldPath: null, binary: false }]);
    expect(c.coverage.get("link")).toEqual(new Set([1]));
    expect(c.diff).toContain("deleted file mode 120000");
    expect(c.diff).toContain("+plain");
  });

  it("never runs a configured clean filter during the temp add", async () => {
    const repo = seeded();
    const marker = join(repo, ".git", "filter-ran");
    git(repo, "config", "filter.mark.clean", `touch '${marker}'; cat`);
    git(repo, "config", "filter.mark.required", "true");
    write(repo, ".gitattributes", "*.dat filter=mark\n");
    commitAll(repo, "attributes");
    rmSync(marker, { force: true });
    write(repo, "new.dat", "raw content\n");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(existsSync(marker)).toBe(false);
    expect(paths(c)).toEqual(["new.dat"]);
    expect(c.diff).toContain("+raw content");
    execFileSync("chmod", ["-R", "a-w", join(repo, ".git")]);
    try {
      await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    } finally {
      execFileSync("chmod", ["-R", "u+w", join(repo, ".git")]);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("keeps zero-context coverage despite GIT_DIFF_OPTS and diff.interHunkContext", async () => {
    const repo = seeded();
    git(repo, "config", "diff.interHunkContext", "10");
    write(repo, "a.ts", lines(10).replace("line 2\n", "line two\n").replace("line 6\n", "line six\n"));
    const saved = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = "--unified=3";
    try {
      const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
      expect(c.coverage.get("a.ts")).toEqual(new Set([2, 6]));
    } finally {
      if (saved === undefined) delete process.env.GIT_DIFF_OPTS;
      else process.env.GIT_DIFF_OPTS = saved;
    }
  });

  it("shows a moved submodule whatever the submodule diff settings say", async () => {
    const repo = seeded();
    const sub = newRepo(join(repo, "sub"));
    write(sub, "s.txt", "1\n");
    commitAll(sub, "s1");
    const first = git(sub, "rev-parse", "HEAD").trim();
    git(repo, "update-index", "--add", "--cacheinfo", `160000,${first},sub`);
    git(repo, "commit", "-q", "-m", "gitlink");
    write(sub, "s.txt", "2\n");
    commitAll(sub, "s2");
    git(repo, "config", "diff.ignoreSubmodules", "all");
    git(repo, "config", "diff.submodule", "log");
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(paths(c)).toEqual(["sub"]);
    expect(c.diff).toContain("Subproject commit");
  });

  it("never fetches a missing object in a partial clone", async () => {
    const bare = tempDir();
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(bare, "config", "uploadpack.allowFilter", "true");
    const src = seeded();
    write(src, "a.ts", lines(11));
    commitAll(src, "second");
    git(src, "push", "-q", bare, "main");
    const clone = join(tempDir(), "clone");
    git(tempDir(), "clone", "-q", "--filter=blob:none", `file://${bare}`, clone);
    const oldBlob = git(clone, "rev-parse", "HEAD~1:a.ts").trim();
    const missing = (): boolean => {
      try {
        execFileSync("git", ["cat-file", "-e", oldBlob], { cwd: clone, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" }, stdio: "ignore" });
        return false;
      } catch {
        return true;
      }
    };
    expect(missing()).toBe(true);
    // A lazy fetch would land in the temp object folder and let the diff
    // succeed; with fetching off, the diff cannot be built and says why.
    await expect(getChange({ repoRoot: clone, scope: { base: "HEAD~1" }, exclude: [] })).rejects.toThrow(
      /not downloaded/,
    );
    expect(missing()).toBe(true);
  });

  it("works in a repo whose path contains a colon", async () => {
    const parent = tempDir();
    const repo = newRepo(join(parent, "proj:one"));
    write(repo, "a.ts", lines(3));
    commitAll(repo, "base");
    write(repo, "a.ts", lines(4));
    const c = await getChange({ repoRoot: repo, scope: {}, exclude: [] });
    expect(c.coverage.get("a.ts")).toEqual(new Set([4]));
  });

  it("finds a same-size edit made in the second the index was written (failure 23)", async () => {
    const repo = newRepo();
    // ctime cannot be set, so git is told not to weigh it; the rest of the
    // stat is made to match: same size, same inode, same mtime second.
    git(repo, "config", "core.trustctime", "false");
    const second = new Date("2026-01-02T03:04:05Z");
    write(repo, "core.ts", "return 1;\n");
    utimesSync(join(repo, "core.ts"), second, second);
    commitAll(repo, "base");
    utimesSync(join(repo, ".git/index"), second, second);
    write(repo, "core.ts", "return 2;\n");
    utimesSync(join(repo, "core.ts"), second, second);
    expect(git(repo, "status", "--porcelain")).toContain("core.ts");
    // git status may have refreshed the index; make it racy again.
    utimesSync(join(repo, ".git/index"), second, second);
    const change = await getChange({ repoRoot: repo, scope: { uncommitted: true }, exclude: [] });
    expect(paths(change)).toEqual(["core.ts"]);
  });
});
