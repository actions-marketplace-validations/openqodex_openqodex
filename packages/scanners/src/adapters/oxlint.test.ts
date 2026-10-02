import { describe, expect, it } from "vitest";
import { parseOxlintJson } from "./oxlint.js";

describe("parseOxlintJson", () => {
  it("returns empty array on blank or diagnostics-less input", () => {
    expect(parseOxlintJson("")).toEqual([]);
    expect(parseOxlintJson(JSON.stringify({}))).toEqual([]);
    expect(parseOxlintJson(JSON.stringify({ diagnostics: "nope" }))).toEqual([]);
  });

  it("normalizes a typical correctness diagnostic, anchoring on the first label span", () => {
    const report = {
      diagnostics: [
        {
          message: "Expected a conditional expression and instead saw an assignment",
          code: "eslint(no-cond-assign)",
          severity: "warning",
          url: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-cond-assign.html",
          filename: "src/app.ts",
          labels: [{ span: { offset: 48, length: 1, line: 4, column: 9 } }],
          related: [],
        },
      ],
      number_of_files: 1,
    };
    const out = parseOxlintJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "oxlint",
      ruleId: "eslint/no-cond-assign",
      filePath: "src/app.ts",
      lineStart: 4,
      lineEnd: 4,
      severity: "medium",
      reference: "https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-cond-assign.html",
    });
    expect(out[0].message).toContain("eslint/no-cond-assign: Expected a conditional");
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

  it("defaults the rule id and skips diagnostics with no filename or no label line", () => {
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
