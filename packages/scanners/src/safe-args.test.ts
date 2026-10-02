import { describe, it, expect } from "vitest";
import { safeFileArgs } from "./safe-args.js";

describe("safeFileArgs", () => {
  it("drops flag-shaped (hyphen-prefixed) paths that would smuggle CLI flags", () => {
    expect(
      safeFileArgs([
        "app/models/user.rb",
        "--require=evil.rb",
        "-rf",
        "src/index.ts",
        "--config=https://attacker/rules.yaml",
      ]),
    ).toEqual(["app/models/user.rb", "src/index.ts"]);
  });

  it("passes normal paths through unchanged", () => {
    const paths = ["a/b.py", "c.go", "Dockerfile", "Gemfile"];
    expect(safeFileArgs(paths)).toEqual(paths);
  });

  it("returns [] when every path is flag-shaped", () => {
    expect(safeFileArgs(["--x", "-y"])).toEqual([]);
  });

  it("returns [] for an empty input", () => {
    expect(safeFileArgs([])).toEqual([]);
  });
});
