import { describe, expect, it } from "vitest";
import { parseBrakemanJson } from "./brakeman.js";

describe("parseBrakemanJson", () => {
  it("empty or warnings-less output yields no findings instead of a parse error", () => {
    expect(parseBrakemanJson("")).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({}))).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({ warnings: "nope" }))).toEqual([]);
  });

  it("a brakeman warning keeps its check name as rule id and puts the flagged code in the message", () => {
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

  it("a warning without a check name gets a rule id and shows its user input; one without a file or line is dropped", () => {
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
