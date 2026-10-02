import { describe, expect, it } from "vitest";
import { isTestFile, computeMissingTestSignal } from "./missing-tests.js";

describe("isTestFile", () => {
  it("flags JS/TS test+spec filename conventions", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("src/foo.spec.tsx")).toBe(true);
    expect(isTestFile("ui/Button.test.jsx")).toBe(true);
  });

  it("flags Go / Python / Ruby / JVM / .NET conventions", () => {
    expect(isTestFile("pkg/handler_test.go")).toBe(true);
    expect(isTestFile("app/test_views.py")).toBe(true);
    expect(isTestFile("lib/user_spec.rb")).toBe(true);
    expect(isTestFile("src/main/UserTest.java")).toBe(true);
    expect(isTestFile("src/UserServiceTests.cs")).toBe(true);
  });

  it("flags files under a test directory regardless of filename", () => {
    expect(isTestFile("test/helpers.ts")).toBe(true);
    expect(isTestFile("src/__tests__/util.ts")).toBe(true);
    expect(isTestFile("spec/models/user.rb")).toBe(true);
    expect(isTestFile("e2e/checkout.ts")).toBe(true);
  });

  it("does not flag ordinary source files", () => {
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("src/contest.ts")).toBe(false); // 'test' is a substring, not a segment
    expect(isTestFile("lib/latest.go")).toBe(false);
    expect(isTestFile("src/testimonials.ts")).toBe(false);
  });
});

describe("computeMissingTestSignal", () => {
  it("is true when source changed but no test files did", () => {
    expect(
      computeMissingTestSignal(["src/api/users.ts", "src/api/auth.ts"]),
    ).toBe(true);
  });

  it("is false when any test file changed alongside source", () => {
    expect(
      computeMissingTestSignal(["src/api/users.ts", "src/api/users.test.ts"]),
    ).toBe(false);
  });

  it("is false when only docs / lockfiles changed (no source)", () => {
    expect(
      computeMissingTestSignal(["README.md", "pnpm-lock.yaml", "docs/x.mdx"]),
    ).toBe(false);
  });

  it("ignores docs / lockfiles when deciding the source count", () => {
    // README + a real source file, no tests -> still fires.
    expect(computeMissingTestSignal(["README.md", "src/x.ts"])).toBe(true);
  });

  it("is false for a test-only change", () => {
    expect(
      computeMissingTestSignal(["src/x.test.ts", "test/helpers.ts"]),
    ).toBe(false);
  });

  it("ignores generated artifacts when counting source", () => {
    // A .d.ts + generated dir change is not 'source' per the denylist;
    // with no real source file the signal stays false.
    expect(
      computeMissingTestSignal(["dist/bundle.js", "types/api.d.ts"]),
    ).toBe(false);
  });

  it("is false on an empty change set", () => {
    expect(computeMissingTestSignal([])).toBe(false);
  });
});
