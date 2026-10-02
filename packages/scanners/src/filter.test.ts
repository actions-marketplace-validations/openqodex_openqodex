import { describe, expect, it } from "vitest";
import {
  filterToChangedLines,
  isFixturePath,
  dropFixtureFindings,
} from "./filter.js";
import type { StaticFinding } from "@openqodex/core";

function finding(over: Partial<StaticFinding>): StaticFinding {
  return {
    source: "semgrep",
    ruleId: "rule",
    filePath: "src/a.ts",
    lineStart: 10,
    lineEnd: 10,
    severity: "high",
    message: "msg",
    reference: null,
    ...over,
  };
}

describe("filterToChangedLines", () => {
  it("keeps findings whose line is inside coverage", () => {
    const coverage = new Map([["src/a.ts", new Set([10])]]);
    const out = filterToChangedLines([finding({})], coverage);
    expect(out).toHaveLength(1);
  });

  it("drops findings on files not in coverage", () => {
    const coverage = new Map([["src/other.ts", new Set([10])]]);
    const out = filterToChangedLines([finding({})], coverage);
    expect(out).toHaveLength(0);
  });

  it("drops findings whose entire span misses coverage", () => {
    const coverage = new Map([["src/a.ts", new Set([1, 2, 3])]]);
    const out = filterToChangedLines(
      [finding({ lineStart: 10, lineEnd: 12 })],
      coverage,
    );
    expect(out).toHaveLength(0);
  });

  it("keeps multi-line findings when any line overlaps coverage", () => {
    const coverage = new Map([["src/a.ts", new Set([12])]]);
    const out = filterToChangedLines(
      [finding({ lineStart: 10, lineEnd: 14 })],
      coverage,
    );
    expect(out).toHaveLength(1);
  });

  it("handles empty coverage gracefully", () => {
    const out = filterToChangedLines([finding({})], new Map());
    expect(out).toHaveLength(0);
  });
});

describe("filterToChangedLines with an unsafe line number", () => {
  // A custom scanner's report can carry any number. Past 2^53, n + 1 === n,
  // so a loop over the span never ends.
  it("does not loop forever on a span ending at 2^53", () => {
    const coverage = new Map([["src/a.ts", new Set([3])]]);
    const huge = 9007199254740992;
    const kept = filterToChangedLines(
      [finding({ lineStart: 1, lineEnd: huge }), finding({ lineStart: huge - 1, lineEnd: huge })],
      coverage,
    );
    expect(kept.map((f) => f.lineStart)).toEqual([1]);
  }, 5_000);
});

describe("isFixturePath", () => {
  it("matches __fixtures__ / fixtures / __mocks__ / mocks dirs", () => {
    expect(isFixturePath("src/__fixtures__/data.json")).toBe(true);
    expect(isFixturePath("test/fixtures/secrets.ts")).toBe(true);
    expect(isFixturePath("src/__mocks__/db.ts")).toBe(true);
    expect(isFixturePath("test/mocks/api.ts")).toBe(true);
  });

  it("matches snapshots / __snapshots__ / fakes / stubs / testdata dirs", () => {
    expect(isFixturePath("src/__snapshots__/foo.snap")).toBe(true);
    expect(isFixturePath("src/snapshots/api.snap")).toBe(true);
    expect(isFixturePath("internal/fakes/server.ts")).toBe(true);
    expect(isFixturePath("test/stubs/clock.ts")).toBe(true);
    expect(isFixturePath("e2e/testdata/users.json")).toBe(true);
  });

  it("matches .fixture. / .mock. / .stub. file suffixes", () => {
    expect(isFixturePath("src/user.fixture.ts")).toBe(true);
    expect(isFixturePath("src/api.fixtures.json")).toBe(true);
    expect(isFixturePath("src/db.mock.ts")).toBe(true);
    expect(isFixturePath("src/clock.stub.ts")).toBe(true);
  });

  it("matches Jest .snap output files", () => {
    expect(isFixturePath("src/__snapshots__/component.test.tsx.snap")).toBe(true);
    expect(isFixturePath("any/path/foo.snap")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isFixturePath("src/Fixtures/data.json")).toBe(true);
    expect(isFixturePath("src/__MOCKS__/db.ts")).toBe(true);
  });

  it("does NOT match real test files (.test., .spec., __tests__/, test/)", () => {
    // Real tests can have genuine bugs: security finding in
    // integration setup, leaked admin token in a test runner. Don't
    // suppress them.
    expect(isFixturePath("src/foo.test.ts")).toBe(false);
    expect(isFixturePath("src/foo.spec.ts")).toBe(false);
    expect(isFixturePath("src/__tests__/foo.test.ts")).toBe(false);
    expect(isFixturePath("test/integration/foo.ts")).toBe(false);
    expect(isFixturePath("tests/integration/foo.ts")).toBe(false);
  });

  it("does NOT false-positive on prod paths that contain similar words", () => {
    // "mockingbird" or "fixtureRetrieve" aren't fixture paths
    expect(isFixturePath("src/mockingbird/server.ts")).toBe(false);
    expect(isFixturePath("src/myfixturestore.ts")).toBe(false);
    expect(isFixturePath("src/components/MockUpRenderer.ts")).toBe(false);
  });

  it("returns false on prod source paths", () => {
    expect(isFixturePath("src/api/billing.ts")).toBe(false);
    expect(isFixturePath("ui/src/App.tsx")).toBe(false);
    expect(isFixturePath("server/routes/users.ts")).toBe(false);
  });
});

describe("dropFixtureFindings", () => {
  it("partitions findings into kept + drop count", () => {
    const f1 = finding({ filePath: "src/api/billing.ts" });
    const f2 = finding({ filePath: "src/__fixtures__/users.json" });
    const f3 = finding({ filePath: "src/db.mock.ts" });
    const f4 = finding({ filePath: "ui/src/App.tsx" });
    const out = dropFixtureFindings([f1, f2, f3, f4]);
    expect(out.kept).toEqual([f1, f4]);
    expect(out.droppedCount).toBe(2);
  });

  it("returns 0 droppedCount when nothing matches", () => {
    const out = dropFixtureFindings([finding({})]);
    expect(out.droppedCount).toBe(0);
    expect(out.kept).toHaveLength(1);
  });

  it("preserves input order for kept findings", () => {
    const out = dropFixtureFindings([
      finding({ filePath: "src/a.ts" }),
      finding({ filePath: "test/fixtures/leaky.json" }),
      finding({ filePath: "src/b.ts" }),
      finding({ filePath: "src/c.ts" }),
    ]);
    expect(out.kept.map((f) => f.filePath)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });
});
