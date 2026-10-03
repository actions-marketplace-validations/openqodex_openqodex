// Ways the repo state access could fail, written before the code:
// 1. A link at the file is followed, so a read or a write lands outside.
// 2. A link at a folder on the way (.openqodex itself) is followed.
// 3. A dangling link is written through, creating its target outside.
// 4. A folder in place of a file is read as if it were one.
// 5. A named pipe or a device in place of a file blocks the read forever.
// 6. A file over the cap is read whole.
// 7. A remove deletes through a linked folder.
// 8. A path that names the state by another spelling (the /var alias of a
//    /private/var root, or another letter case on a case-insensitive disk)
//    is not seen as state, so a flag that names it skips these checks.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRepoState, readRepoFile, removeRepoFile, repoStat, writeRepoFile } from "../src/repo-state.js";

function repo(): { root: string; away: string } {
  const root = mkdtempSync(join(tmpdir(), "oq-state-"));
  const away = mkdtempSync(join(tmpdir(), "oq-state-away-"));
  writeFileSync(join(away, "f.json"), "outside\n");
  return { root, away };
}

describe("repo state access", () => {
  it("a link at the file is refused for read and write, and its target is untouched", () => {
    const { root, away } = repo();
    mkdirSync(join(root, ".openqodex"));
    symlinkSync(join(away, "f.json"), join(root, ".openqodex/f.json"));
    expect(() => readRepoFile(root, ".openqodex/f.json")).toThrow("is a symbolic link");
    expect(() => writeRepoFile(root, ".openqodex/f.json", "x")).toThrow("is a symbolic link");
    expect(readFileSync(join(away, "f.json"), "utf8")).toBe("outside\n");
  });

  it("a link at a folder on the way is refused for read, write, stat and remove", () => {
    const { root, away } = repo();
    symlinkSync(away, join(root, ".openqodex"));
    expect(() => readRepoFile(root, ".openqodex/f.json")).toThrow("is a symbolic link");
    expect(() => repoStat(root, ".openqodex/f.json")).toThrow("is a symbolic link");
    expect(() => writeRepoFile(root, ".openqodex/new.json", "x")).toThrow("is a symbolic link");
    expect(() => removeRepoFile(root, ".openqodex/f.json")).toThrow("is a symbolic link");
    expect(existsSync(join(away, "new.json"))).toBe(false);
    expect(readFileSync(join(away, "f.json"), "utf8")).toBe("outside\n");
  });

  it("a dangling link is never written through, so its target is never created", () => {
    const { root, away } = repo();
    mkdirSync(join(root, ".openqodex"));
    symlinkSync(join(away, "made.txt"), join(root, ".openqodex/.gitignore"));
    expect(() => writeRepoFile(root, ".openqodex/.gitignore", "*\n", { exclusive: true })).toThrow("is a symbolic link");
    expect(existsSync(join(away, "made.txt"))).toBe(false);
  });

  it("a folder in place of a file is refused", () => {
    const { root } = repo();
    mkdirSync(join(root, ".openqodex/f.json"), { recursive: true });
    expect(() => readRepoFile(root, ".openqodex/f.json")).toThrow("is not a regular file");
  });

  it("a named pipe in place of a file is refused without blocking", () => {
    const { root } = repo();
    mkdirSync(join(root, ".openqodex"));
    execFileSync("mkfifo", [join(root, ".openqodex/latest.json")]);
    expect(() => readRepoFile(root, ".openqodex/latest.json")).toThrow("is not a regular file");
  });

  it("a file over the cap is refused, not read whole", () => {
    const { root } = repo();
    mkdirSync(join(root, ".openqodex"));
    writeFileSync(join(root, ".openqodex/big.json"), "x".repeat(2049));
    expect(() => readRepoFile(root, ".openqodex/big.json", 2048, "; shorten it")).toThrow("over the 2 KB limit; shorten it");
    expect(readRepoFile(root, ".openqodex/big.json", 4096)).toHaveLength(2049);
  });

  it("missing files and folders read as null, and a write makes the real folders on the way", () => {
    const { root } = repo();
    expect(readRepoFile(root, ".openqodex/reviews/x/run.json")).toBeNull();
    expect(writeRepoFile(root, ".openqodex/reviews/x/run.json", "{}\n")).toBe(true);
    expect(writeRepoFile(root, ".openqodex/reviews/x/run.json", "[]\n", { exclusive: true })).toBe(false);
    expect(readRepoFile(root, ".openqodex/reviews/x/run.json")).toBe("{}\n");
  });

  it("sees the state under another spelling of the repo root", (ctx) => {
    const typed = mkdtempSync(join(tmpdir(), "oq-state-alias-"));
    const root = realpathSync(typed);
    if (root === typed) {
      process.stdout.write("skipped: the temp folder has no second spelling here\n");
      ctx.skip();
    }
    mkdirSync(join(root, ".openqodex"));
    expect(isRepoState(root, join(typed, ".openqodex/config.yaml"))).toBe(join(".openqodex", "config.yaml"));
    expect(isRepoState(root, join(typed, "src/config.yaml"))).toBeNull();
  });

  it("sees the state under another letter case on a case-insensitive disk", (ctx) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oq-state-case-")));
    writeFileSync(join(root, "probe"), "");
    if (!existsSync(join(root, "PROBE"))) {
      process.stdout.write("skipped: this disk tells letter case apart\n");
      ctx.skip();
    }
    mkdirSync(join(root, ".openqodex"));
    expect(isRepoState(root, ".OpenQodex/config.yaml")).toBe(join(".OpenQodex", "config.yaml"));
    expect(isRepoState(root, ".OpenQodex.YAML")).toBe(".OpenQodex.YAML");
  });
});
