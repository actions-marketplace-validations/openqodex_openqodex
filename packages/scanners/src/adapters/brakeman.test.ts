import { describe, expect, it } from "vitest";
import { parseBrakemanJson } from "./brakeman.js";

describe("parseBrakemanJson", () => {
  it("returns empty array on blank or warnings-less input", () => {
    expect(parseBrakemanJson("")).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({}))).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({ warnings: "nope" }))).toEqual([]);
  });

  it("normalizes a typical SQL injection warning with check_name token", () => {
    const report = {
      warnings: [
        {
          warning_type: "SQL Injection",
          check_name: "SQL",
          message: "Possible SQL injection",
          file: "app/models/user.rb",
          line: 12,
          confidence: "High",
          code: "User.where(\"name = '#{params[:name]}'\")",
          user_input: "params[:name]",
          link: "https://brakemanscanner.org/docs/warning_types/sql_injection/",
        },
      ],
    };
    const out = parseBrakemanJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "brakeman",
      ruleId: "SQL",
      filePath: "app/models/user.rb",
      lineStart: 12,
      lineEnd: 12,
      severity: "high",
      reference: "https://brakemanscanner.org/docs/warning_types/sql_injection/",
    });
    // message folds in warning_type, message, and the code snippet detail.
    expect(out[0].message).toContain("SQL Injection: Possible SQL injection");
    expect(out[0].message).toContain("User.where");
  });

  it("maps brakeman confidence High/Medium/Weak to high/medium/low", () => {
    const report = {
      warnings: [
        { check_name: "A", warning_type: "t", message: "m", file: "a.rb", line: 1, confidence: "High" },
        { check_name: "B", warning_type: "t", message: "m", file: "a.rb", line: 2, confidence: "Medium" },
        { check_name: "C", warning_type: "t", message: "m", file: "a.rb", line: 3, confidence: "Weak" },
      ],
    };
    const out = parseBrakemanJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "low"]);
  });

  it("defaults rule id, falls back to user_input detail, and skips rows with no file or line", () => {
    const report = {
      warnings: [
        { warning_type: "Mass Assignment", message: "m", file: "app/c.rb", line: 4, user_input: "params" },
        { check_name: "X", warning_type: "t", message: "m", file: "", line: 1 },
        { check_name: "X", warning_type: "t", message: "m", file: "a.rb", line: 0 },
        { check_name: "X", warning_type: "t", message: "m", file: "a.rb" },
      ],
    };
    const out = parseBrakemanJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("brakeman");
    expect(out[0].message).toContain("[params]");
  });
});
