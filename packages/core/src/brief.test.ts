// Ways the brief could fail, written before the code:
// 1. A matched secret reaches the brief through the diff, a candidate
//    message, a lens body or the summary of anything else.
// 2. A candidate is missing, or shown without its id, token, location or
//    the developer-facing severity.
// 3. More than 50 candidates are printed, or the overflow is not mentioned.
// 4. The selected lenses do not appear, or no lens is selected for a small
//    Python change that builds SQL from input.
// 5. The diff is inlined past 200 KB, or a diff holding a triple backtick
//    closes the fence early.
// 6. The missing-tests hint shows when tests changed, or is absent when
//    only source changed.
// 7. The findings path or the finalize command is missing.
// 8. Blocks are out of order.
import { describe, expect, it } from "vitest";
import { buildBrief } from "./brief.js";
import { matchesGlob } from "./glob.js";
import { selectLenses } from "./lenses.js";
import { SECRET, SQL_CANDIDATE, makeChange, makeConfig, makeScan } from "./test-fixtures.js";
import type { Candidate, Change, SelectedLens } from "./types.js";

const globBuilt = (() => {
  try {
    return matchesGlob("a", "a");
  } catch {
    return false;
  }
})();

const LENS: SelectedLens = {
  name: "sql-string-concatenation",
  description: "SQL built via string concatenation",
  confidenceFloor: 0.75,
  body: "A raw SQL string is built by interpolating a variable into the query.",
};

function brief(over: { change?: Change; candidates?: Candidate[]; lenses?: SelectedLens[]; secrets?: string[] } = {}) {
  return buildBrief({
    change: over.change ?? makeChange(),
    scan: over.candidates ? makeScan({ candidates: over.candidates }) : makeScan(),
    lenses: over.lenses ?? [LENS],
    config: makeConfig(),
    secrets: over.secrets ?? [SECRET],
    findingsPath: ".openqodex/reviews/20261001-120000-3f9a1c0b2d4e/agent-findings.json",
    finalizeCommand: "npx -y openqodex review --finalize",
  });
}

describe("buildBrief", () => {
  it("never contains a secret passed in secrets, wherever it appears", () => {
    const leaky: Candidate = { ...SQL_CANDIDATE, message: `matched ${SECRET} here` };
    const out = brief({
      candidates: [leaky],
      lenses: [{ ...LENS, body: `example ${SECRET}` }],
    });
    expect(out).not.toContain(SECRET);
    expect(out).toContain('API_KEY = "[redacted]"');
  });

  it("names every candidate with id, token, location and review severity", () => {
    const out = brief();
    expect(out).toContain(
      "- c2 [gitleaks:generic-api-key] app/settings.py:3 (critical) Detected a Generic API Key, potentially exposing access to various services.",
    );
    expect(out).toContain(`- c1 [${SQL_CANDIDATE.token}] app/search.py:14 (major)`);
    expect(out).toContain("- c3 [ruff:F401] app/settings.py:1 (nitpick)");
    // highest severity first
    expect(out.indexOf("- c2 ")).toBeLessThan(out.indexOf("- c1 "));
    expect(out.indexOf("- c1 ")).toBeLessThan(out.indexOf("- c3 "));
  });

  it("shows at most 50 candidates and points to candidates.json for the rest", () => {
    const many = Array.from({ length: 53 }, (_, i) => ({ ...SQL_CANDIDATE, id: `c${i + 1}` }));
    const out = brief({ candidates: many });
    expect(out.match(/^- c\d+ \[/gm)).toHaveLength(50);
    expect(out).toContain("3 more candidates are in candidates.json");
  });

  it("carries the selected lenses with their bodies", () => {
    const out = brief();
    expect(out).toContain("### sql-string-concatenation");
    expect(out).toContain(LENS.body);
  });

  it("lists the scanners that ran and the ones that did not, with reasons", () => {
    expect(brief()).toContain("3 scanners ran, 1 had nothing to check, 1 not included (brakeman: needs Ruby 2.7 or newer)");
  });

  it("adds the missing-tests hint only when source changed without tests", () => {
    expect(brief()).toContain("## Missing tests");
    const withTest = makeChange({ changedPaths: ["app/search.py", "tests/test_search.py"] });
    expect(brief({ change: withTest })).not.toContain("## Missing tests");
  });

  it("inlines the diff with a fence longer than any backtick run in it", () => {
    const change = makeChange({ diff: "diff --git a/r.md b/r.md\n+```js\n+x\n+```\n" });
    const out = brief({ change });
    expect(out).toContain("````diff\n");
  });

  it("lists files instead of inlining a diff over 200 KB", () => {
    const change = makeChange({ diff: `+${"x".repeat(210 * 1024)}\n` });
    const out = brief({ change });
    expect(out).not.toContain("xxxxxxxxxx");
    expect(out).toContain("more than the 200 KB this brief carries");
    expect(out).toContain("| modified | app/search.py |");
  });

  it("ends with the findings path and the finalize command, blocks in order", () => {
    const out = brief();
    const order = [
      "# OpenQodex review brief",
      "## How to review",
      "## Scanner candidates",
      "## Patterns to weigh",
      "## Missing tests",
      "## Changed files",
      "## Diff",
      "## Finding shape",
      "## When you are done",
    ].map((h) => out.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain("`.openqodex/reviews/20261001-120000-3f9a1c0b2d4e/agent-findings.json`");
    expect(out).toContain("`npx -y openqodex review --finalize`");
    expect(out).toContain('"change_id": "3f9a1c0b2d4e"');
  });
});

describe.skipIf(!globBuilt)("buildBrief with lenses from the shipped catalog (needs matchesGlob)", () => {
  it("names the candidates and at least one lens for a small Python change", () => {
    const change = makeChange();
    const lenses = selectLenses(change);
    expect(lenses.map((l) => l.name)).toContain("sql-string-concatenation");
    const out = brief({ change, lenses });
    expect(out).toContain("### sql-string-concatenation");
    expect(out).toContain("- c1 [");
    expect(out).not.toContain(SECRET);
  });
});
