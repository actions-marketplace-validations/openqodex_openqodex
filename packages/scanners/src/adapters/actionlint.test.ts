import { describe, expect, it } from "vitest";
import { parseActionlintJson } from "./actionlint.js";

describe("parseActionlintJson", () => {
  it("returns empty array on blank or non-array input", () => {
    expect(parseActionlintJson("")).toEqual([]);
    expect(parseActionlintJson(JSON.stringify({}))).toEqual([]);
  });

  it("normalizes a typical actionlint entry", () => {
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

  it("maps non-security kinds to medium", () => {
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

  it("bumps shellcheck-in-workflow findings to high", () => {
    const report = [
      {
        message: "shellcheck reported issue in run step: SC2086",
        filepath: ".github/workflows/ci.yml",
        line: 20,
        column: 1,
        kind: "shellcheck",
      },
    ];
    const out = parseActionlintJson(JSON.stringify(report));
    expect(out[0].severity).toBe("high");
  });

  it("defaults rule id and skips rows with no filepath or line", () => {
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
