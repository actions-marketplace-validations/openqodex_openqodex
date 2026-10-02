import { describe, expect, it } from "vitest";
import { parseActionlintJson } from "./actionlint.js";

describe("parseActionlintJson", () => {
  it("empty or non-list output yields no findings instead of a parse error", () => {
    expect(parseActionlintJson("")).toEqual([]);
    expect(parseActionlintJson(JSON.stringify({}))).toEqual([]);
  });

  it("an actionlint entry keeps its file, line and kind as rule id, and an expression problem ranks high", () => {
    const report = [
      {
        message: 'property "runn" is not defined in object type',
        filepath: ".github/workflows/ci.yml",
        line: 12,
        column: 9,
        kind: "expression",
      },
    ];
    const out = parseActionlintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "actionlint",
      ruleId: "expression",
      filePath: ".github/workflows/ci.yml",
      lineStart: 12,
      lineEnd: 12,
      severity: "high",
    });
  });

  it("a non-security workflow problem ranks medium, so it does not block like an injection", () => {
    const report = [
      {
        message: "label is unknown",
        filepath: ".github/workflows/ci.yml",
        line: 3,
        column: 5,
        kind: "runner-label",
      },
    ];
    const out = parseActionlintJson(JSON.stringify(report));
    expect(out[0].severity).toBe("medium");
  });

  it("an entry without a kind gets a rule id, and one without a file or line is dropped", () => {
    const report = [
      { message: "m", filepath: "", line: 1, kind: "expression" },
      { message: "m", filepath: "f.yml", line: 0, kind: "expression" },
      { message: "m", filepath: "f.yml", line: 4 },
    ];
    const out = parseActionlintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("actionlint");
  });
});
