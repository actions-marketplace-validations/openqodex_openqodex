// The change between two commits over the admitted paths only (the server
// review's folder scopes and review.paths.exclude), read from the clone's
// trees alone. That a refused file and the old version of a file renamed in
// from outside reach no part of the review is the decisive fixture's to show
// (packages/review/test/scoped-review.test.ts); these cover the rest.
//
// Ways it could fail, written before the code:
//  1. With every path admitted, the change differs from getTreeChange's for
//     the same commits (its id, files, renames, coverage, deletion points
//     or diff), so a server review of the whole repository is not the
//     laptop's review of it.
//  2. The clone is written: an object, the index, or anything else under
//     .git gains a file or changes its bytes, or a temporary folder is left
//     behind.
//  3. A commit holding a path no checkout may write (a ".git" or ".." part)
//     is diffed with that path quietly dropped, instead of being refused.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getAdmittedTreeChange, getTreeChange } from "../src/change.js";
import { matchesGlob } from "../src/glob.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);
const saved = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  if (saved.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = saved.global;
  if (saved.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = saved.system;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@openqodex.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", input: "" }).trim();
}

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

const OLD_BODY = Array.from({ length: 30 }, (_, i) => `export const outsideValue${i} = "OLD-OUTSIDE-${i}";`).join("\n") + "\n";

// A base commit, then a head commit that changes a root file, an excluded
// file inside the admitted folder and a file inside it, renames a file
// inside it, and moves a file from outside into it with one line changed.
function repo(): { dir: string; base: string; head: string } {
  const dir = tempDir("oq-admit-");
  git(dir, "init", "-q", "-b", "main");
  write(dir, "canary.txt", "root canary base\n");
  write(dir, "services/api/a.ts", "export const a = 1;\n");
  write(dir, "services/api/generated/g.ts", "export const g = 1;\n");
  write(dir, "services/api/old-name.ts", Array.from({ length: 20 }, (_, i) => `export const inside${i} = ${i};`).join("\n") + "\n");
  write(dir, "legacy/moved.ts", OLD_BODY);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  write(dir, "canary.txt", "root canary CHANGED\n");
  write(dir, "services/api/a.ts", "export const a = 2;\nexport const b = 3;\n");
  write(dir, "services/api/generated/g.ts", "export const g = 2;\n");
  git(dir, "mv", "services/api/old-name.ts", "services/api/new-name.ts");
  git(dir, "mv", "legacy/moved.ts", "services/api/moved.ts");
  write(dir, "services/api/moved.ts", OLD_BODY.replace('"OLD-OUTSIDE-3"', '"NEW-INSIDE-3"'));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "head");
  return { dir, base, head: git(dir, "rev-parse", "HEAD") };
}

const scoped = (exclude: string[]) => (path: string) => (path.startsWith("services/api/") && !exclude.some((g) => matchesGlob(path, g)));

describe("the change over the admitted paths", () => {
  it("1. with every path admitted, it is the same change getTreeChange gives", async () => {
    const r = repo();
    const args = { repoRoot: r.dir, baseRef: "main", baseSha: r.base, headSha: r.head, exclude: ["**/generated/**"] };
    const plain = await getTreeChange(args);
    const { change, renamedIn } = await getAdmittedTreeChange({ ...args, admit: () => true });
    expect(change).toEqual(plain);
    expect(renamedIn).toEqual([]);
  });

  it("2. nothing in the clone is written, and no temporary folder is left", async () => {
    const r = repo();
    // Every file and its bytes. Git may refresh the time of an object it
    // finds in the clone (as the laptop's change source does); it never
    // adds or changes one.
    const listing = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${join(e.parentPath, e.name)} ${createHash("sha256").update(readFileSync(join(e.parentPath, e.name))).digest("hex")}`).sort();
    const before = listing(join(r.dir, ".git"));
    // A temp folder of this test's own: other test files running at the
    // same time make and remove their own openqodex-scope- folders.
    vi.stubEnv("TMPDIR", tempDir("oq-admitted-tmp-"));
    try {
      await getAdmittedTreeChange({ repoRoot: r.dir, baseRef: "main", baseSha: r.base, headSha: r.head, exclude: [], admit: scoped([]) });
      expect(listing(join(r.dir, ".git"))).toEqual(before);
      expect(readdirSync(tmpdir())).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("3. a commit holding a path no checkout may write is refused, never quietly dropped", async () => {
    const r = repo();
    const blob = git(r.dir, "rev-parse", `${r.head}:services/api/a.ts`);
    const tree = git(r.dir, "rev-parse", `${r.head}^{tree}`);
    for (const name of [".git", ".GIT", ".."]) {
      // A tree that git itself refuses to check out, written by hand.
      const api = execFileSync("git", ["mktree"], { cwd: r.dir, input: `100644 blob ${blob}\t${name}\n100644 blob ${blob}\ta.ts\n`, encoding: "utf8" }).trim();
      const services = execFileSync("git", ["mktree"], { cwd: r.dir, input: `040000 tree ${api}\tapi\n`, encoding: "utf8" }).trim();
      const top = git(r.dir, "ls-tree", tree).split("\n").filter((l) => !l.endsWith("\tservices")).join("\n");
      const root = execFileSync("git", ["mktree"], { cwd: r.dir, input: `${top}\n040000 tree ${services}\tservices\n`, encoding: "utf8" }).trim();
      const bad = git(r.dir, "commit-tree", root, "-p", r.base, "-m", "bad");
      await expect(getAdmittedTreeChange({ repoRoot: r.dir, baseRef: "main", baseSha: r.base, headSha: bad, exclude: [], admit: scoped([]) })).rejects.toThrow(/a path no checkout may write/);
    }
  });
});
