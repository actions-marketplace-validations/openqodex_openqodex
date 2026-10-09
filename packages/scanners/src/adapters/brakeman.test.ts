import { describe, expect, it } from "vitest";
import { parseBrakemanJson } from "./brakeman.js";

describe("parseBrakemanJson", () => {
  it("empty or warnings-less output yields no findings instead of a parse error", () => {
    expect(parseBrakemanJson("")).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({}))).toEqual([]);
    expect(parseBrakemanJson(JSON.stringify({ warnings: "nope" }))).toEqual([]);
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
