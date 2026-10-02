import { describe, expect, it } from "vitest";
import { parseRubocopJson } from "./rubocop.js";

const withConfig = { hasConfig: true };
const noConfig = { hasConfig: false };

describe("parseRubocopJson", () => {
  it("returns empty array on blank or files-less input", () => {
    expect(parseRubocopJson("", withConfig)).toEqual([]);
    expect(parseRubocopJson(JSON.stringify({}), withConfig)).toEqual([]);
  });

  it("normalizes a typical offense with cop_name token and span", () => {
    const report = {
      files: [
        {
          path: "app/models/user.rb",
          offenses: [
            {
              cop_name: "Lint/UselessAssignment",
              message: "Useless assignment to variable `x`.",
              location: { start_line: 3, last_line: 4, line: 3 },
            },
          ],
        },
      ],
    };
    const out = parseRubocopJson(JSON.stringify(report), withConfig);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "rubocop",
      ruleId: "Lint/UselessAssignment",
      filePath: "app/models/user.rb",
      lineStart: 3,
      lineEnd: 4,
      severity: "medium",
      reference: null,
    });
    expect(out[0].message).toContain("Lint/UselessAssignment: Useless assignment");
  });

  it("maps departments Security/Lint/Performance/Style to high/medium/low/info", () => {
    const report = {
      files: [
        {
          path: "a.rb",
          offenses: [
            { cop_name: "Security/Eval", message: "m", location: { start_line: 1 } },
            { cop_name: "Lint/Void", message: "m", location: { start_line: 2 } },
            { cop_name: "Performance/Detect", message: "m", location: { start_line: 3 } },
            { cop_name: "Style/StringLiterals", message: "m", location: { start_line: 4 } },
          ],
        },
      ],
    };
    const out = parseRubocopJson(JSON.stringify(report), withConfig);
    expect(out.map((f) => f.severity)).toEqual(["high", "medium", "low", "info"]);
  });

  it("without a repo config, drops Style/Layout and keeps Lint/Security/Performance", () => {
    const report = {
      files: [
        {
          path: "a.rb",
          offenses: [
            { cop_name: "Style/StringLiterals", message: "m", location: { start_line: 1 } },
            { cop_name: "Layout/LineLength", message: "m", location: { start_line: 2 } },
            { cop_name: "Lint/Void", message: "m", location: { start_line: 3 } },
            { cop_name: "Security/Open", message: "m", location: { start_line: 4 } },
            { cop_name: "Performance/Count", message: "m", location: { start_line: 5 } },
          ],
        },
      ],
    };
    const out = parseRubocopJson(JSON.stringify(report), noConfig);
    expect(out.map((f) => f.ruleId)).toEqual([
      "Lint/Void",
      "Security/Open",
      "Performance/Count",
    ]);
  });

  it("with a repo config, keeps the same Style/Layout offenses", () => {
    const report = {
      files: [
        {
          path: "a.rb",
          offenses: [
            { cop_name: "Style/StringLiterals", message: "m", location: { start_line: 1 } },
            { cop_name: "Layout/LineLength", message: "m", location: { start_line: 2 } },
          ],
        },
      ],
    };
    const out = parseRubocopJson(JSON.stringify(report), withConfig);
    expect(out).toHaveLength(2);
  });

  it("falls back to location.line and skips offenses with no path or line", () => {
    const report = {
      files: [
        { path: "", offenses: [{ cop_name: "Lint/Void", message: "m", location: { start_line: 1 } }] },
        {
          path: "a.rb",
          offenses: [
            { cop_name: "Lint/Void", message: "m", location: { line: 7 } },
            { cop_name: "Lint/Void", message: "m", location: { start_line: 0 } },
            { cop_name: "Lint/Void", message: "m" },
          ],
        },
      ],
    };
    const out = parseRubocopJson(JSON.stringify(report), withConfig);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ filePath: "a.rb", lineStart: 7, lineEnd: 7 });
  });
});
