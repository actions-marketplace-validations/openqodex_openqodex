import { describe, expect, it } from "vitest";
import { parseBanditJson } from "./bandit.js";

describe("parseBanditJson", () => {
  it("returns empty array on blank or results-less input", () => {
    expect(parseBanditJson("")).toEqual([]);
    expect(parseBanditJson(JSON.stringify({}))).toEqual([]);
    expect(parseBanditJson(JSON.stringify({ results: "nope" }))).toEqual([]);
  });

  it("normalizes a typical SQL-injection result with test_id token", () => {
    const report = {
      errors: [],
      results: [
        {
          filename: "app/db.py",
          issue_confidence: "MEDIUM",
          issue_severity: "MEDIUM",
          issue_text: "Possible SQL injection vector through string-based query construction.",
          line_number: 12,
          line_range: [12],
          more_info: "https://bandit.readthedocs.io/en/1.9.4/plugins/b608_hardcoded_sql_expressions.html",
          test_id: "B608",
          test_name: "hardcoded_sql_expressions",
        },
      ],
    };
    const out = parseBanditJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "bandit",
      ruleId: "B608",
      filePath: "app/db.py",
      lineStart: 12,
      lineEnd: 12,
      severity: "medium",
      reference: "https://bandit.readthedocs.io/en/1.9.4/plugins/b608_hardcoded_sql_expressions.html",
    });
    // message folds the test_id into the issue_text.
    expect(out[0].message).toContain("B608: Possible SQL injection");
  });

  it("maps issue_severity HIGH/MEDIUM/LOW to high/medium/low", () => {
    const report = {
      results: [
        { test_id: "B602", issue_severity: "HIGH", issue_text: "t", filename: "a.py", line_number: 1 },
        { test_id: "B404", issue_severity: "MEDIUM", issue_text: "t", filename: "a.py", line_number: 2 },
        { test_id: "B101", issue_severity: "LOW", issue_text: "t", filename: "a.py", line_number: 3 },
      ],
    };
    const out = parseBanditJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
  });

  it("defaults the rule id and skips rows with no filename or line", () => {
    const report = {
      results: [
        { issue_severity: "LOW", issue_text: "assert used", filename: "app/c.py", line_number: 4 },
        { test_id: "B101", issue_severity: "LOW", issue_text: "t", filename: "", line_number: 1 },
        { test_id: "B101", issue_severity: "LOW", issue_text: "t", filename: "a.py", line_number: 0 },
        { test_id: "B101", issue_severity: "LOW", issue_text: "t", filename: "a.py" },
      ],
    };
    const out = parseBanditJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("bandit");
    expect(out[0].message).toContain("assert used");
  });
});
