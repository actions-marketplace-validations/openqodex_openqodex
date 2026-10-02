import { describe, expect, it } from "vitest";
import { parseRuffJson } from "./ruff.js";

describe("parseRuffJson", () => {
  it("returns empty array on blank or non-array input", () => {
    expect(parseRuffJson("")).toEqual([]);
    expect(parseRuffJson(JSON.stringify({}))).toEqual([]);
  });

  it("normalizes a typical ruff diagnostic with location span", () => {
    const report = [
      {
        code: "F401",
        message: "`os` imported but unused",
        filename: "app/main.py",
        location: { row: 2, column: 1 },
        end_location: { row: 2, column: 10 },
        url: "https://docs.astral.sh/ruff/rules/unused-import/",
      },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      source: "ruff",
      ruleId: "F401",
      filePath: "app/main.py",
      lineStart: 2,
      lineEnd: 2,
      severity: "low",
      reference: "https://docs.astral.sh/ruff/rules/unused-import/",
    });
  });

  it("maps security S-rules to high and pure style to info", () => {
    const report = [
      {
        code: "S602",
        message: "subprocess call with shell=True",
        filename: "a.py",
        location: { row: 1, column: 1 },
        end_location: { row: 1, column: 1 },
      },
      {
        code: "E501",
        message: "line too long",
        filename: "a.py",
        location: { row: 2, column: 1 },
        end_location: { row: 2, column: 1 },
      },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out.map((f) => f.severity)).toEqual(["high", "info"]);
  });

  it("spans multiple lines via end_location.row", () => {
    const report = [
      {
        code: "B006",
        message: "mutable default arg",
        filename: "a.py",
        location: { row: 4, column: 1 },
        end_location: { row: 6, column: 1 },
      },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out[0].lineStart).toBe(4);
    expect(out[0].lineEnd).toBe(6);
    expect(out[0].severity).toBe("low");
  });

  it("defaults rule id and skips rows with no filename or row", () => {
    const report = [
      { code: "F401", message: "m", filename: "", location: { row: 1 } },
      { code: "F401", message: "m", filename: "a.py", location: { row: 0 } },
      { message: "syntax error", filename: "a.py", location: { row: 3 } },
    ];
    const out = parseRuffJson(JSON.stringify(report));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("ruff");
    expect(out[0].reference).toBeNull();
  });
});
