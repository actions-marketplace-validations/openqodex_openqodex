import { describe, it, expect } from "vitest";
import { safeFileArgs } from "./safe-args.js";

// Failure list:
//   1. A path that starts with "-" reaches the tool as a flag.
//   2. A path that starts with "-" is dropped, so the file is never scanned.
//   3. An ordinary path is changed.

describe("safeFileArgs", () => {
  it("keeps flag-shaped paths as ./-prefixed paths so they are scanned, not parsed as flags (1, 2)", () => {
    expect(
      safeFileArgs([
        "app/models/user.rb",
        "--require=evil.rb",
        "-rf",
        "src/index.ts",
        "--config=https://attacker/rules.yaml",
      ]),
    ).toEqual([
      "app/models/user.rb",
      "./--require=evil.rb",
      "./-rf",
      "src/index.ts",
      "./--config=https://attacker/rules.yaml",
    ]);
  });
});
