import { describe, expect, it } from "vitest";
import { parseOxlintJson } from "./oxlint.js";

describe("parseOxlintJson", () => {
  it("empty or diagnostics-less output yields no findings instead of a parse error", () => {
    expect(parseOxlintJson("")).toEqual([]);
    expect(parseOxlintJson(JSON.stringify({}))).toEqual([]);
    expect(parseOxlintJson(JSON.stringify({ diagnostics: "nope" }))).toEqual([]);
  });

  it("ranks security rules high, style rules info, and correctness rules medium", () => {
    const report = {
      diagnostics: [
        { code: "eslint(no-eval)", message: "m", filename: "a.js", labels: [{ span: { line: 1 } }] },
        { code: "stylistic(indent)", message: "m", filename: "a.js", labels: [{ span: { line: 2 } }] },
        { code: "eslint(no-unused-vars)", message: "m", filename: "a.js", labels: [{ span: { line: 3 } }] },
      ],
    };
    const out = parseOxlintJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "info", "medium"]);
  });

  it("a diagnostic without a code gets a rule id; one without a file or a labelled line is dropped", () => {
    const report = {
      diagnostics: [
        { message: "syntax", filename: "a.js", labels: [{ span: { line: 9 } }] },
        { code: "eslint(no-debugger)", message: "m", filename: "", labels: [{ span: { line: 1 } }] },
        { code: "eslint(no-debugger)", message: "m", filename: "a.js", labels: [] },
        { code: "eslint(no-debugger)", message: "m", filename: "a.js", labels: [{ span: { line: 0 } }] },
      ],
    };
    const out = parseOxlintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "oxlint", filePath: "a.js", lineStart: 9 });
  });
});
