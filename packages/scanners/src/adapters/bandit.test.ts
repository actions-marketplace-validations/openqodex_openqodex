import { describe, expect, it } from "vitest";
import { parseBanditJson } from "./bandit.js";

describe("parseBanditJson", () => {
  it("empty or results-less output yields no findings instead of a parse error", () => {
    expect(parseBanditJson("")).toEqual([]);
    expect(parseBanditJson(JSON.stringify({}))).toEqual([]);
    expect(parseBanditJson(JSON.stringify({ results: "nope" }))).toEqual([]);
  });

  it("a result without a test id gets a rule id, and one without a file or line is dropped", () => {
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
