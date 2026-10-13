// Failures written before extending the converter's test-gap predicate:
// 1. A missing-coverage or uncovered-behaviour title survives the rule.
// 2. A real test bug, or a bug-category finding, is removed.
import { describe, expect, it } from "vitest";
import { isTestGap } from "../outside/convert/aacr.mjs";

describe("board test-gap classification loses or removes the wrong finding", () => {
  it.each([
    "Changed behaviour has no covering test",
    "Uncovered provider behavior changes",
    "Missing Activity validation coverage",
    "Declaration diagnostic branch lacks coverage",
  ])("recognizes the test request: %s", (title) => {
    expect(isTestGap({ category: "maintainability", title })).toBe(true);
  });
  it.each([
    { category: "maintainability", title: "Custom-port test patches the wrong HTTP client" },
    { category: "maintainability", title: "Incorrect view-bound target types" },
    { category: "bug", title: "Missing test fixture crashes the loader" },
    { category: "bug", title: "Missing Activity validation coverage" },
  ])("keeps the defect: $title ($category)", (finding) => {
    expect(isTestGap(finding)).toBe(false);
  });
});
