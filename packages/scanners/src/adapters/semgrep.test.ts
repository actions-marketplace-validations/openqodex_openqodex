import { describe, expect, it } from "vitest";
import { parseSemgrepJson } from "./semgrep.js";

describe("parseSemgrepJson", () => {
  it("empty output yields no findings instead of a parse error", () => {
    expect(parseSemgrepJson("")).toEqual([]);
    expect(parseSemgrepJson("   ")).toEqual([]);
  });

  it("a semgrep result keeps its check id, file, line span and first reference, and ERROR ranks high", () => {
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

  it("a result with no end line spans only its start line", () => {
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

  it("a null or empty result row is skipped without failing the whole parse", () => {
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
