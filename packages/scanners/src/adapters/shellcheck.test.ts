import { describe, expect, it } from "vitest";
import { parseShellcheckJson } from "./shellcheck.js";

describe("parseShellcheckJson", () => {
  it("empty or non-list output yields no findings instead of a parse error", () => {
    expect(parseShellcheckJson("")).toEqual([]);
    expect(parseShellcheckJson(JSON.stringify({}))).toEqual([]);
  });

  it("a multi-line shellcheck finding spans to endLine, and a missing endLine falls back to the start line", () => {
    const report = [
      { file: "a.sh", line: 5, endLine: 8, level: "warning", code: 2046, message: "m" },
      { file: "a.sh", line: 5, level: "warning", code: 2046, message: "m" },
    ];
    const out = parseShellcheckJson(JSON.stringify(report));
    expect(out[0].lineEnd).toBe(8);
    expect(out[1].lineEnd).toBe(5);
  });

  it("an entry without a code gets a rule id and no wiki link; one without a file or line is dropped", () => {
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
