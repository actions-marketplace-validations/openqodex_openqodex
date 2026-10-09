// Ways switching off a repo's filter drivers could fail, written before the fix:
// 1. A driver whose command has spaces and dots is parsed as another driver
//    name, so the real driver stays on.
// 2. A driver with a name `-c key=value` cannot carry (a space, an equals
//    sign) is skipped instead of refused, so it stays on.
import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { safeGitConfig } from "../src/safe-git.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

function repo(): string {
  const dir = tempDir("oq-safe-git-");
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

describe("the filter drivers a folder's git config names", () => {
  it("switches off a driver whose command holds spaces and dots (failure 1)", async () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "filter.lfs.smudge", "sh ./tools/run.sh smudge v1.2 %f"]);
    const args = await safeGitConfig(dir);
    expect(args).toContain("filter.lfs.smudge=");
    expect(args).toContain("filter.lfs.process=");
    expect(args.filter((a) => a.startsWith("filter.") && !a.startsWith("filter.lfs."))).toEqual([]);
  });

  it("refuses a driver whose name cannot be carried by -c, rather than leaving it on (failure 2)", async () => {
    const dir = repo();
    execFileSync("git", ["-C", dir, "config", "filter.my filter.smudge", "cat"]);
    await expect(safeGitConfig(dir)).rejects.toThrow(/cannot switch off/);
  });
});
