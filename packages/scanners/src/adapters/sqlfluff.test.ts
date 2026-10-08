// The SQLFluff parser on its real output, and the files and rules SQLFluff
// is given. violations.json is sqlfluff 4.3.0's own JSON (timings removed)
// for test/fixtures/sqlfluff/repo, run with the adapter's flags.
//
// Failure list, written before the code:
//   1. A parse error becomes a finding: a file in a dialect other than the
//      one SQLFluff reads it in gives one PRS per unparsable statement, a
//      flood that names no problem in the code.
//   2. A rule outside the list the adapter asked for (a style rule, a parse
//      or lexer error) reaches the report.
//   3. A rule that names a wrong result (= NULL, a set query whose sides
//      differ in columns, a cross join with no condition, a reference to a
//      table not in FROM, a repeated table alias) ranks as low as dead code,
//      or a rule the repo set as a warning ranks above info.
//   4. A finding loses its file, its lines or its rule link.
//   5. Empty output or a non-list crashes the parser instead of yielding
//      nothing.
//   6. The rule list holds a style rule (layout, capitalisation, quoting),
//      which fires on almost every line of hand-written SQL.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoFacts } from "../detect.js";
import { parseSqlfluffJson, sqlfluff, SQLFLUFF_RULES } from "./sqlfluff.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/sqlfluff/violations.json"), "utf8");

describe("parseSqlfluffJson on sqlfluff 4.3.0 output", () => {
  const out = parseSqlfluffJson(fixture);

  it("keeps the asked-for rules and drops the parse errors (1, 2)", () => {
    expect(out.map((f) => [f.ruleId, f.lineStart, f.lineEnd])).toEqual([
      ["CV05", 1, 1],
      ["AM07", 2, 2],
      ["AL04", 3, 3],
      ["AL08", 4, 4],
      ["RF01", 5, 5],
      ["AM08", 6, 6],
      ["ST03", 7, 7],
      ["ST11", 10, 10],
    ]);
  });

  it("ranks a wrong result medium, dead code low and a repo's warning info (3)", () => {
    expect(Object.fromEntries(out.map((f) => [f.ruleId, f.severity]))).toEqual({
      CV05: "medium",
      AM07: "medium",
      AL04: "medium",
      AL08: "low",
      RF01: "medium",
      AM08: "medium",
      // warnings = ST03 in the repo's .sqlfluff.
      ST03: "info",
      ST11: "low",
    });
  });

  it("keeps the file, the description and a link to the rule's page (4)", () => {
    expect(out[0]).toEqual({
      source: "sqlfluff",
      ruleId: "CV05",
      filePath: "reports/weekly.sql",
      lineStart: 1,
      lineEnd: 1,
      severity: "medium",
      message: 'Comparisons with NULL should use "IS" or "IS NOT". (convention.is_null)',
      reference: "https://docs.sqlfluff.com/en/stable/reference/rules/convention.html#cv05",
    });
  });

  it("yields nothing for empty output or a non-list (5)", () => {
    expect(parseSqlfluffJson("")).toEqual([]);
    expect(parseSqlfluffJson("{}")).toEqual([]);
    expect(parseSqlfluffJson(JSON.stringify([null, { filepath: "a.sql" }, { filepath: "a.sql", violations: [null, { code: "CV05" }] }]))).toEqual([]);
  });
});

describe("the files and rules SQLFluff is given", () => {
  const facts = repoFacts(dirname(fileURLToPath(import.meta.url)));
  it("takes every changed .sql file, in any case", () => {
    expect(sqlfluff.files(["db/q.sql", "db/Q.SQL", "db/q.py", "-x.sql"], facts)).toEqual(["db/q.sql", "db/Q.SQL", "./-x.sql"]);
  });

  it("asks only for rules that name a wrong or dead query, never a style rule (6)", () => {
    expect(SQLFLUFF_RULES).toEqual(["AL04", "AL08", "AM07", "AM08", "CV05", "RF01", "ST03", "ST11"]);
  });
});
