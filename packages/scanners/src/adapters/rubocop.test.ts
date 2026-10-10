import { describe, expect, it } from "vitest";
import { parseRubocopJson } from "./rubocop.js";

const withConfig = { hasConfig: true };
const noConfig = { hasConfig: false };

describe("parseRubocopJson", () => {
  it("empty or files-less output yields no findings instead of a parse error", () => {
    expect(parseRubocopJson("", withConfig)).toEqual([]);
    expect(parseRubocopJson(JSON.stringify({}), withConfig)).toEqual([]);
  });

  it("Style and Layout offenses nobody opted into are dropped; Lint, Security and Performance are kept", () => {
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

  it("an offense with only location.line still anchors; one without a path or line is dropped", () => {
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
