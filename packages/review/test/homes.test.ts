// Ways environment home paths could fail:
// 1. A bare Windows drive root loses its slash and becomes drive-relative.
// 2. An absolute Windows folder is prefixed with the current folder.
// 3. A single POSIX backslash folder name is trimmed to an empty string.
// 4. Trailing slashes after a drive root are trimmed into the root, which
//    leaves a drive-relative path.
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { fromEnv } from "../src/agents/homes.js";

describe("environment home paths", () => {
  it("keeps a bare Windows drive root absolute", () => {
    expect(fromEnv("F:\\", win32)).toBe("F:\\");
  });

  it("keeps a drive root absolute when it ends in two slashes", () => {
    expect(fromEnv("F:\\\\", win32)).toBe("F:\\");
  });

  it("does not prefix an absolute Windows folder with cwd", () => {
    expect(fromEnv("F:\\config", win32)).toBe("F:\\config");
  });

  it("preserves a single POSIX backslash as a relative folder name", () => {
    expect(fromEnv("\\", posix)).toBe(`${process.cwd()}/\\`);
  });
});
