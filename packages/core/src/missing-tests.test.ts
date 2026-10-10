import { describe, expect, it } from "vitest";
import { isTestFile, computeMissingTestSignal } from "./missing-tests.js";

describe("isTestFile", () => {
  it("a file under a test folder counts as a test, so changing it silences the missing-tests hint", () => {
    expect(isTestFile("test/helpers.ts")).toBe(true);
    expect(isTestFile("src/__tests__/util.ts")).toBe(true);
    expect(isTestFile("spec/models/user.rb")).toBe(true);
    expect(isTestFile("e2e/checkout.ts")).toBe(true);
  });

  it("a source file whose name only contains 'test' (contest.ts) is not taken for a test", () => {
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("src/contest.ts")).toBe(false); // 'test' is a substring, not a segment
    expect(isTestFile("lib/latest.go")).toBe(false);
    expect(isTestFile("src/testimonials.ts")).toBe(false);
  });
});

describe("computeMissingTestSignal", () => {
  it("is false when only docs / lockfiles changed (no source)", () => {
    expect(
      computeMissingTestSignal(["README.md", "pnpm-lock.yaml", "docs/x.mdx"]),
    ).toBe(false);
  });

  it("ignores generated artifacts when counting source", () => {
    // A .d.ts + generated dir change is not 'source' per the denylist;
    // with no real source file the signal stays false.
    expect(
      computeMissingTestSignal(["dist/bundle.js", "types/api.d.ts"]),
    ).toBe(false);
  });
});
