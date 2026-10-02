import { describe, expect, it } from "vitest";
import { parseHadolintJson } from "./hadolint.js";

describe("parseHadolintJson", () => {
  it("returns empty array on blank or non-array input", () => {
    expect(parseHadolintJson("")).toEqual([]);
    expect(parseHadolintJson(JSON.stringify({}))).toEqual([]);
  });

  it("normalizes a typical hadolint entry and builds wiki reference", () => {
    const report = [
      {
        file: "Dockerfile",
        line: 3,
        column: 1,
        level: "warning",
        code: "DL3008",
        message: "Pin versions in apt get install.",
      },
    ];
    const out = parseHadolintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "hadolint",
      ruleId: "DL3008",
      filePath: "Dockerfile",
      lineStart: 3,
      lineEnd: 3,
      severity: "medium",
      reference: "https://github.com/hadolint/hadolint/wiki/DL3008",
    });
  });

  it("maps the level scale error/warning/info/style", () => {
    const report = [
      { file: "Dockerfile", line: 1, level: "error", code: "DL3000", message: "m" },
      { file: "Dockerfile", line: 2, level: "warning", code: "DL3001", message: "m" },
      { file: "Dockerfile", line: 3, level: "info", code: "DL3002", message: "m" },
      { file: "Dockerfile", line: 4, level: "style", code: "DL3003", message: "m" },
    ];
    const out = parseHadolintJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "low", "info"]);
  });

  it("defaults rule id and skips rows with no file or line", () => {
    const report = [
      { file: "", line: 1, level: "error", code: "DL1", message: "m" },
      { file: "Dockerfile", line: 0, level: "error", code: "DL1", message: "m" },
      { file: "Dockerfile", line: 5, level: "warning", message: "m" },
    ];
    const out = parseHadolintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("hadolint");
    expect(out[0].reference).toBeNull();
  });
});
