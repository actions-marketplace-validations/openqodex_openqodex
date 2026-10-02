import { describe, expect, it } from "vitest";
import { parseSemgrepJson } from "./semgrep.js";

describe("parseSemgrepJson", () => {
  it("returns empty array on blank input", () => {
    expect(parseSemgrepJson("")).toEqual([]);
    expect(parseSemgrepJson("   ")).toEqual([]);
  });

  it("returns empty array when results is missing or not array", () => {
    expect(parseSemgrepJson(JSON.stringify({}))).toEqual([]);
    expect(parseSemgrepJson(JSON.stringify({ results: "nope" }))).toEqual([]);
  });

  it("normalizes a typical semgrep result", () => {
    const raw = {
      results: [
        {
          check_id: "javascript.lang.security.audit.path-traversal-source",
          path: "src/server.ts",
          start: { line: 12, col: 3 },
          end: { line: 14, col: 8 },
          extra: {
            severity: "ERROR",
            message:
              "Tainted source from req.params flows to fs.readFileSync.",
            metadata: { references: ["https://owasp.org/path-traversal"] },
          },
        },
      ],
    };
    const findings = parseSemgrepJson(JSON.stringify(raw));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      source: "semgrep",
      ruleId: "javascript.lang.security.audit.path-traversal-source",
      filePath: "src/server.ts",
      lineStart: 12,
      lineEnd: 14,
      severity: "high",
      reference: "https://owasp.org/path-traversal",
    });
  });

  it("maps severity WARNING -> medium and INFO -> info", () => {
    const raw = {
      results: [
        {
          check_id: "a",
          path: "p",
          start: { line: 1 },
          end: { line: 1 },
          extra: { severity: "WARNING", message: "m" },
        },
        {
          check_id: "b",
          path: "p",
          start: { line: 2 },
          end: { line: 2 },
          extra: { severity: "INFO", message: "m" },
        },
      ],
    };
    const out = parseSemgrepJson(JSON.stringify(raw));
    expect(out.map((f) => f.severity)).toEqual(["medium", "info"]);
  });

  it("falls back to lineStart when end.line is missing or invalid", () => {
    const raw = {
      results: [
        {
          check_id: "a",
          path: "p",
          start: { line: 5 },
          end: {},
          extra: { severity: "WARNING", message: "m" },
        },
      ],
    };
    const out = parseSemgrepJson(JSON.stringify(raw));
    expect(out[0].lineEnd).toBe(5);
  });

  it("skips malformed rows without throwing", () => {
    const raw = {
      results: [
        null,
        {},
        { check_id: "ok", path: "p", start: { line: 1 }, end: { line: 1 } },
      ],
    };
    const out = parseSemgrepJson(JSON.stringify(raw));
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("ok");
  });
});
