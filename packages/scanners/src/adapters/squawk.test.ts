// The squawk parser on its real output, the files squawk is given and how
// their names reach it. violations.json is squawk 2.66.0's own JSON for
// test/fixtures/squawk/repo/db/migrations/0002_orders.sql.
//
// Failure list, written before the code:
//   1. squawk's lines count from 0; a finding lands one line early.
//   2. A statement over several lines loses its last line, so a change to
//      that line drops the finding.
//   3. A rule that names a lock or a rewrite (an index built without
//      CONCURRENTLY, a constraint that scans the table) ranks as low as a
//      preference (IF NOT EXISTS, timeouts, bigint), or the other way round.
//   4. squawk reads each path as a glob pattern: a changed file named
//      `[1]x.sql` would make it lint `1x.sql` instead, and `*` would pull in
//      other files. Every glob character must reach it escaped.
//   5. Empty output, a non-list or an entry with no file or line crashes the
//      parser instead of yielding nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoFacts } from "../detect.js";
import { globLiteral, parseSquawkJson, squawk } from "./squawk.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/squawk/violations.json"), "utf8");

describe("parseSquawkJson on squawk 2.66.0 output", () => {
  const out = parseSquawkJson(fixture);

  it("gives each finding its 1-based first and last line (1, 2)", () => {
    expect(out.map((f) => [f.ruleId, f.lineStart, f.lineEnd])).toEqual([
      ["require-lock-timeout", 2, 3],
      ["require-statement-timeout", 2, 3],
      ["adding-required-field", 3, 3],
      ["prefer-robust-stmts", 3, 3],
      ["prefer-robust-stmts", 5, 6],
      ["require-concurrent-index-creation", 5, 6],
      ["constraint-missing-not-valid", 8, 9],
      ["prefer-robust-stmts", 8, 9],
      ["adding-foreign-key-constraint", 8, 9],
    ]);
  });

  it("keeps the file, joins the message and its help, and links the rule", () => {
    expect(out.find((f) => f.ruleId === "require-concurrent-index-creation")).toEqual({
      source: "squawk",
      ruleId: "require-concurrent-index-creation",
      filePath: "db/migrations/0002_orders.sql",
      lineStart: 5,
      lineEnd: 6,
      severity: "medium",
      message: "During normal index creation, table updates are blocked, but reads are still allowed. Use `concurrently` to avoid blocking writes.",
      reference: "https://squawkhq.com/docs/require-concurrent-index-creation",
    });
  });

  it("ranks a lock or rewrite medium and a preference low (3)", () => {
    const severity = Object.fromEntries(out.map((f) => [f.ruleId, f.severity]));
    expect(severity).toEqual({
      "require-lock-timeout": "low",
      "require-statement-timeout": "low",
      "adding-required-field": "medium",
      "prefer-robust-stmts": "low",
      "require-concurrent-index-creation": "medium",
      "constraint-missing-not-valid": "medium",
      "adding-foreign-key-constraint": "medium",
    });
  });

  it("yields nothing for empty output, a non-list, or an entry with no file or line (5)", () => {
    expect(parseSquawkJson("")).toEqual([]);
    expect(parseSquawkJson("{}")).toEqual([]);
    expect(parseSquawkJson(JSON.stringify([null, 3, { rule_name: "x", line: 0 }, { file: "a.sql", rule_name: "x" }]))).toEqual([]);
  });
});

describe("the files squawk is given", () => {
  const facts = repoFacts(dirname(fileURLToPath(import.meta.url)));
  it("takes every changed .sql file, in any case", () => {
    expect(squawk.files(["db/0001.sql", "db/Seed.SQL", "db/notes.md", "-x.sql"], facts)).toEqual(["db/0001.sql", "db/Seed.SQL", "./-x.sql"]);
  });

  it("escapes every glob character, so each name matches only itself (4)", () => {
    expect(globLiteral("db/[1]x*?.sql")).toBe("db/[[]1[]]x[*][?].sql");
    expect(globLiteral("db/plain-name_1.sql")).toBe("db/plain-name_1.sql");
  });
});
