import { describe, expect, it } from "vitest";
import { parseHadolintJson } from "./hadolint.js";

describe("parseHadolintJson", () => {
  it("empty or non-list output yields no findings instead of a parse error", () => {
    expect(parseHadolintJson("")).toEqual([]);
    expect(parseHadolintJson(JSON.stringify({}))).toEqual([]);
  });

  it("a hadolint entry keeps its DL code as rule id and links to that rule's wiki page", () => {
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

  it("an entry without a code gets a rule id and no wiki link; one without a file or line is dropped", () => {
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
