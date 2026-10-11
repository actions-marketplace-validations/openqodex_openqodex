import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSemgrepJson, readRulePack, rulePackHash } from "./semgrep.js";

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

// The Semgrep registry hands out one pack in more than one byte form: every
// response its origin makes lists the same rules in another order (two
// CloudFront edges served p/default at 2195213 bytes with other bytes on
// 2026-10-11), and an edge can serve the YAML form, because the cache key
// ignores the Accept header semgrep sends. Two fetches of one rule set must
// get one sha256, and a change to any rule must get another.
describe("rulePackHash", () => {
  const gets = { id: "c.gets", pattern: "gets(...)", message: "Avoid gets.", languages: ["c"], severity: "WARNING", metadata: { cwe: ["CWE-676"] } };
  const evalRule = { id: "js.eval", patterns: [{ pattern: "eval($X)" }, { "pattern-not": 'eval("...")' }], message: "No eval.", languages: ["js"], severity: "ERROR" };
  const secret = { id: "yaml.secret", "pattern-regex": "\\$\\{\\{\\s*secrets\\.", message: "A secret in env.", languages: ["yaml"], severity: "WARNING" };
  const json = (rules: unknown[], missed = 1856) => JSON.stringify({ rules, missed });

  it("two fetches that list the same rules in another order get one sha256", () => {
    const first = rulePackHash(json([gets, evalRule, secret]));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(rulePackHash(json([secret, gets, evalRule]))).toBe(first);
  });

  it("a rule whose keys come in another order gets the same sha256", () => {
    const reordered = { severity: gets.severity, metadata: gets.metadata, languages: gets.languages, message: gets.message, pattern: gets.pattern, id: gets.id };
    expect(rulePackHash(json([reordered, evalRule]))).toBe(rulePackHash(json([gets, evalRule])));
  });

  it("the YAML form of a pack gets the sha256 of its JSON form, whose count of rules left out is not rule content", () => {
    const yaml = [
      "rules:",
      "- id: js.eval",
      "  patterns:",
      "  - pattern: eval($X)",
      "  - pattern-not: eval(\"...\")",
      "  message: No eval.",
      "  languages:",
      "  - js",
      "  severity: ERROR",
      "- id: c.gets",
      "  pattern: gets(...)",
      "  message: Avoid gets.",
      "  languages:",
      "  - c",
      "  severity: WARNING",
      "  metadata:",
      "    cwe:",
      "    - CWE-676",
      "",
    ].join("\n");
    expect(rulePackHash(yaml)).toBe(rulePackHash(json([gets, evalRule])));
    expect(rulePackHash(json([gets, evalRule], 12))).toBe(rulePackHash(json([gets, evalRule])));
  });

  it("a one-byte change inside a rule's pattern gets another sha256", () => {
    const text = json([gets, evalRule, secret]);
    const at = text.indexOf("gets(...)");
    const altered = Buffer.from(text);
    altered[at] = "f".charCodeAt(0);
    expect(altered.length).toBe(Buffer.byteLength(text));
    expect(rulePackHash(altered)).toMatch(/^[0-9a-f]{64}$/);
    expect(rulePackHash(altered)).not.toBe(rulePackHash(text));
  });

  it("is the sha256 of the documented form, so anyone can recompute it from the docs: rules by id, keys sorted, compact JSON, rules only", () => {
    const pack = JSON.stringify({ missed: 3, rules: [{ message: "m", id: "b", pattern: "x" }, { pattern: "y", id: "a", metadata: { z: 1, a: [2, 1] } }] });
    const documented = '{"rules":[{"id":"a","metadata":{"a":[2,1],"z":1},"pattern":"y"},{"id":"b","message":"m","pattern":"x"}]}';
    expect(rulePackHash(pack)).toBe(createHash("sha256").update(documented).digest("hex"));
  });

  it("two rules with one id are ordered by their own normal form, as the docs say, so either order gets one sha256", () => {
    const later = { id: "a", pattern: "z" };
    const earlier = { pattern: "b", id: "a" };
    const documented = '{"rules":[{"id":"a","pattern":"b"},{"id":"a","pattern":"z"}]}';
    const expected = createHash("sha256").update(documented).digest("hex");
    expect(rulePackHash(JSON.stringify({ rules: [later, earlier] }))).toBe(expected);
    expect(rulePackHash(JSON.stringify({ rules: [earlier, later] }))).toBe(expected);
  });

  it("a rules list with an entry that is not a rule with a string id gets no sha256, so the record never names a hash of something else", () => {
    expect(rulePackHash('{"rules":[null]}')).toBeNull();
    expect(rulePackHash('{"rules":[["c.gets"]]}')).toBeNull();
    expect(rulePackHash('{"rules":[{"pattern":"gets(...)"}]}')).toBeNull();
    expect(rulePackHash('{"rules":[{"id":3,"pattern":"gets(...)"}]}')).toBeNull();
    expect(rulePackHash(JSON.stringify({ rules: [gets, null] }))).toBeNull();
    expect(readRulePack(JSON.stringify({ rules: [gets, evalRule], missed: 2 }))).toEqual([gets, evalRule]);
    expect(readRulePack('{"rules":[null]}')).toBeNull();
  });

  it("bytes that are not a rule pack get no sha256, so the record never names a hash of something else", () => {
    expect(rulePackHash("<html>Bad gateway</html>")).toBeNull();
    expect(rulePackHash('{"error":"not found"}')).toBeNull();
    expect(rulePackHash("")).toBeNull();
  });
});
