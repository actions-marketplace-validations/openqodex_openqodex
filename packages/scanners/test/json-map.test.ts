// Ways parseJsonMap could fail, written before the code:
// 1. Text that is not JSON comes back as no findings, so a broken tool looks clean.
// 2. The items path does not reach the array: dotted keys, `[n]` indexes, or
//    "." for a root array are read wrong; a path that hits something other
//    than an array is not reported.
// 3. A clean run where the tool leaves the items key out or null is reported
//    as a failure.
// 4. Field paths with indexes (`extra.metadata.references[0]`) are not read.
// 5. An item without a file or a usable line is kept; a line given as a
//    numeric string is dropped.
// 6. A path outside the repo is kept; an absolute path inside it is not made
//    relative; the macOS temp folder symlink is not handled.
// 7. Severity: a value not in severity_map is not medium; a missing severity
//    path is not medium.
// 8. The json-map of semgrep's own JSON disagrees with its SARIF on files,
//    lines or rule ids.
// 9. Anything that looks like an expression (filters, wildcards) is evaluated.
import { cpSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonMap } from "@openqodex/core";
import { afterAll, describe, expect, it } from "vitest";
import { parseJsonMap } from "../src/formats/json-map.js";
import { parseSarif } from "../src/formats/sarif.js";
import { removeTempDirs, tempDir } from "../../../tests/temp-dirs.mjs";

afterAll(removeTempDirs);

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function sampleRepo(): string {
  const dir = tempDir("oq-jsonmap-");
  cpSync(join(fixtures, "sample"), dir, { recursive: true });
  return dir;
}

const semgrepMap: JsonMap = {
  items: "results",
  file: "path",
  line: "start.line",
  end_line: "end.line",
  rule: "check_id",
  severity: "extra.severity",
  message: "extra.message",
  reference: "extra.metadata.references[0]",
  severity_map: { ERROR: "high", WARNING: "medium", INFO: "low" },
};

const map = (over: Partial<JsonMap>): JsonMap => ({
  items: ".",
  file: "f",
  line: "l",
  end_line: null,
  rule: "r",
  severity: null,
  message: "m",
  reference: null,
  severity_map: {},
  ...over,
});

const key = (f: { filePath: string; lineStart: number; lineEnd: number; ruleId: string }) =>
  `${f.filePath}:${f.lineStart}-${f.lineEnd} ${f.ruleId}`;

describe("parseJsonMap", () => {
  it("throws on text that is not JSON (1)", () => {
    expect(() => parseJsonMap("{", map({}), { repoDir: "/r", source: "custom:x" })).toThrow(/not valid JSON/);
  });

  it("maps semgrep's real JSON to the same files, lines and rule ids as its SARIF (2, 4, 8)", () => {
    const repoDir = sampleRepo();
    const opts = { repoDir, source: "custom:semgrep" as const };
    const viaMap = parseJsonMap(readFileSync(join(fixtures, "json-map", "semgrep.json"), "utf8"), semgrepMap, opts);
    const viaSarif = parseSarif(readFileSync(join(fixtures, "sarif", "semgrep.sarif"), "utf8"), opts);
    expect(viaMap.map(key).sort()).toEqual(viaSarif.map(key).sort());
    expect(viaMap).toHaveLength(4);
    const shell = viaMap.find((f) => f.ruleId === "tmp.s6-rules.shell-true");
    expect(shell).toMatchObject({
      source: "custom:semgrep",
      severity: "high",
      message: "subprocess called with shell=True runs the argument through a shell",
      reference: "https://docs.python.org/3/library/subprocess.html#security-considerations",
    });
    expect(viaMap.find((f) => f.ruleId === "tmp.s6-rules.eval-call")?.severity).toBe("low");
    expect(viaMap.find((f) => f.ruleId === "tmp.s6-rules.sql-format")?.reference).toBeNull();
  });

  it("reads a root array, nested items with indexes, and reports a path that is not an array (2, 3)", () => {
    const repoDir = sampleRepo();
    const opts = { repoDir, source: "custom:x" as const };
    const item = { f: "Dockerfile", l: 2, r: "x1", m: "msg" };
    expect(parseJsonMap(JSON.stringify([item]), map({}), opts)).toHaveLength(1);
    const nested = { runs: [{ out: { list: [] } }, { out: { list: [item, item] } }] };
    expect(parseJsonMap(JSON.stringify(nested), map({ items: "runs[1].out.list" }), opts)).toHaveLength(2);
    expect(parseJsonMap(JSON.stringify({ grid: [[item]] }), map({ items: "grid[0]" }), opts)).toHaveLength(1);
    expect(parseJsonMap("{}", map({ items: "results" }), opts)).toEqual([]);
    expect(parseJsonMap('{"results": null}', map({ items: "results" }), opts)).toEqual([]);
    expect(() => parseJsonMap('{"results": {"a": 1}}', map({ items: "results" }), opts)).toThrow(/results/);
    expect(() => parseJsonMap(JSON.stringify(nested), map({ items: "runs[*].out.list" }), opts)).toThrow(/runs\[\*\]/);
    expect(() => parseJsonMap(JSON.stringify(nested), map({ items: "runs[?(@.out)]" }), opts)).toThrow();
  });

  it("drops unusable items, keeps numeric strings, rebases paths (5, 6)", () => {
    const repoDir = sampleRepo();
    const items = [
      { f: "app/views.py", l: "6", r: "a", m: "numeric string line" },
      { f: join(repoDir, "Dockerfile"), l: 4, e: 2, r: "b", m: "absolute inside, end before start" },
      { l: 3, r: "c", m: "no file" },
      { f: "Dockerfile", r: "d", m: "no line" },
      { f: "Dockerfile", l: 0, r: "e", m: "line zero" },
      { f: "Dockerfile", l: 1.5, r: "f", m: "not a whole number" },
      { f: "../outside.py", l: 1, r: "g", m: "outside" },
      { f: "/etc/hosts", l: 1, r: "h", m: "absolute outside" },
      { f: "Dockerfile", l: 3, e: 5, r: 42, m: "" },
    ];
    const findings = parseJsonMap(JSON.stringify(items), map({ end_line: "e" }), { repoDir, source: "custom:x" });
    expect(findings.map(key)).toEqual(["app/views.py:6-6 a", "Dockerfile:4-4 b", "Dockerfile:3-5 42"]);
    expect(findings[2]?.message).toBe("42");
  });

  it("maps severity through severity_map and falls back to medium (7)", () => {
    const repoDir = sampleRepo();
    const items = ["HIGH", "weird", undefined, "Low"].map((s, i) => ({ f: "Dockerfile", l: i + 1, r: "x", m: "m", s }));
    const findings = parseJsonMap(
      JSON.stringify(items),
      map({ severity: "s", severity_map: { HIGH: "critical", Low: "low" } }),
      { repoDir, source: "custom:x" },
    );
    expect(findings.map((f) => f.severity)).toEqual(["critical", "medium", "medium", "low"]);
    const noPath = parseJsonMap(JSON.stringify(items), map({}), { repoDir, source: "custom:x" });
    expect(noPath.every((f) => f.severity === "medium")).toBe(true);
  });
});
