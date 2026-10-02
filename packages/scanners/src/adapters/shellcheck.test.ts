import { describe, expect, it } from "vitest";
import { parseShellcheckJson } from "./shellcheck.js";

describe("parseShellcheckJson", () => {
  it("returns empty array on blank or non-array input", () => {
    expect(parseShellcheckJson("")).toEqual([]);
    expect(parseShellcheckJson(JSON.stringify({}))).toEqual([]);
  });

  it("normalizes a typical shellcheck entry with SC prefix and span", () => {
    const report = [
      {
        file: "scripts/deploy.sh",
        line: 7,
        endLine: 7,
        column: 5,
        level: "warning",
        code: 2086,
        message: "Double quote to prevent globbing and word splitting.",
      },
    ];
    const out = parseShellcheckJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "shellcheck",
      ruleId: "SC2086",
      filePath: "scripts/deploy.sh",
      lineStart: 7,
      lineEnd: 7,
      severity: "medium",
      reference: "https://www.shellcheck.net/wiki/SC2086",
    });
  });

  it("maps the level scale error/warning/info/style", () => {
    const report = [
      { file: "a.sh", line: 1, level: "error", code: 1000, message: "m" },
      { file: "a.sh", line: 2, level: "warning", code: 1001, message: "m" },
      { file: "a.sh", line: 3, level: "info", code: 1002, message: "m" },
      { file: "a.sh", line: 4, level: "style", code: 1003, message: "m" },
    ];
    const out = parseShellcheckJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "low", "info"]);
  });

  it("uses endLine for the span and falls back to line when missing", () => {
    const report = [
      { file: "a.sh", line: 5, endLine: 8, level: "warning", code: 2046, message: "m" },
      { file: "a.sh", line: 5, level: "warning", code: 2046, message: "m" },
    ];
    const out = parseShellcheckJson(JSON.stringify(report));
    expect(out[0].lineEnd).toBe(8);
    expect(out[1].lineEnd).toBe(5);
  });

  it("defaults rule id and skips rows with no file or line", () => {
    const report = [
      { file: "", line: 1, level: "error", code: 2000, message: "m" },
      { file: "a.sh", line: 0, level: "error", code: 2000, message: "m" },
      { file: "a.sh", line: 9, level: "warning", message: "m" },
    ];
    const out = parseShellcheckJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("shellcheck");
    expect(out[0].reference).toBeNull();
  });
});
