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
// 9. A link inside the state that points back at the root stands in for the
//    root, so a path spelled inside the state is not seen as state.
// 10. A link elsewhere in the repo that points into the state lets a path
//    outside the state by its spelling read or write the state.
// 11. A name the file system reads as the state but the text does not (case
//    at a deeper part, a zero-width character in a folder not made yet) is
//    not seen as state.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isRepoState, readRepoFile, removeRepoFile, repoStat, writeRepoFile } from "../src/repo-state.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function repo(): { root: string; away: string } {
  const root = tempDir("oq-state-");
  const away = tempDir("oq-state-away-");
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

  it("sees the state under another spelling of the repo root", (ctx) => {
    const typed = tempDir("oq-state-alias-");
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
    const root = realpathSync(tempDir("oq-state-case-"));
    writeFileSync(join(root, "probe"), "");
    if (!existsSync(join(root, "PROBE"))) {
      process.stdout.write("skipped: this disk tells letter case apart\n");
      ctx.skip();
    }
    mkdirSync(join(root, ".openqodex"));
    // The folder exists, so its real name is handed on.
    expect(isRepoState(root, ".OpenQodex/config.yaml")).toBe(join(".openqodex", "config.yaml"));
    expect(isRepoState(root, ".OpenQodex.YAML")).toBe(".OpenQodex.YAML");
  });

  it("a link inside the state back to the root never stands in for the root", () => {
    const root = realpathSync(tempDir("oq-state-loop-"));
    mkdirSync(join(root, ".openqodex"));
    symlinkSync("..", join(root, ".openqodex/r"));
    expect(isRepoState(root, ".openqodex/r/x.json")).toBe(join(".openqodex", "r", "x.json"));
    expect(() => readRepoFile(root, join(".openqodex", "r", "x.json"))).toThrow("is a symbolic link");
  });

  it("a path that reaches the state through a link elsewhere in the repo is refused", () => {
    const root = realpathSync(tempDir("oq-state-into-"));
    mkdirSync(join(root, ".openqodex"));
    mkdirSync(join(root, "docs"));
    symlinkSync("../.openqodex", join(root, "docs/x"));
    expect(() => isRepoState(root, "docs/x/config.yaml")).toThrow("reaches the repo's .openqodex files through a symbolic link");
    expect(isRepoState(root, "docs/y/config.yaml")).toBeNull();
  });

  it("a case variant of a deeper part is still state and reaches the link checks", (ctx) => {
    const root = realpathSync(tempDir("oq-state-deep-"));
    writeFileSync(join(root, "probe"), "");
    if (!existsSync(join(root, "PROBE"))) {
      process.stdout.write("skipped: this disk tells letter case apart\n");
      ctx.skip();
    }
    const away = tempDir("oq-state-away-");
    mkdirSync(join(root, ".openqodex"));
    symlinkSync(away, join(root, ".openqodex/reviews"));
    const spelled = isRepoState(root, ".openqodex/Reviews/x.json");
    expect(spelled).not.toBeNull();
    expect(() => writeRepoFile(root, spelled!, "{}")).toThrow("is a symbolic link");
    expect(existsSync(join(away, "x.json"))).toBe(false);
  });

  it("a folder not made yet whose name holds a zero-width character is still state", () => {
    const root = realpathSync(tempDir("oq-state-zw-"));
    expect(isRepoState(root, ".open\u200Cqodex/config.yaml")).not.toBeNull();
    expect(isRepoState(root, ".OPENQODEX.yaml.")).not.toBeNull();
    expect(isRepoState(root, "src/.openqodex/config.yaml")).toBeNull();
  });
});
