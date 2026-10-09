// The zizmor parser on its real output, and the files zizmor is given.
// findings.json is zizmor 1.30.1's own JSON for the files under
// test/fixtures/zizmor/repo (run with --offline --no-config).
//
// Failure list, written before the code:
//   1. A finding is anchored on a location other than zizmor's primary one:
//      template-injection also names the whole step and the `run` key, so the
//      finding lands on a line the change may not have touched.
//   2. zizmor's rows count from 0; a finding lands one line early.
//   3. A span that ends at column 0 of a row ends on the line before it, and
//      reading the row as the last line takes in one line too many.
//   4. A severity or confidence is mapped wrongly: a high-confidence high
//      finding must rank high; a low-confidence one ranks one step lower.
//   5. Empty output, or a finding with no primary local location, crashes
//      the parser instead of yielding nothing.
//   6. The gate takes a file zizmor would read as the wrong kind (a YAML file
//      outside .github/workflows read as a workflow) or misses one GitHub
//      reads (an action's metadata in any folder, .github/dependabot.yml).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { repoFacts } from "../detect.js";
import { parseZizmorJson, zizmor } from "./zizmor.js";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/zizmor/findings.json"), "utf8");

describe("parseZizmorJson on zizmor 1.30.1 output", () => {
  const out = parseZizmorJson(fixture);
  const find = (file: string, rule: string) => out.filter((f) => f.filePath === file && f.ruleId === rule);

  it("anchors template injection on the expression's own line, not the step or the run key (1, 2)", () => {
    expect(find(".github/workflows/ci.yml", "template-injection")).toEqual([
      {
        source: "zizmor",
        ruleId: "template-injection",
        filePath: ".github/workflows/ci.yml",
        lineStart: 10,
        lineEnd: 10,
        severity: "high",
        message: "code injection via template expansion: may expand into attacker-controllable code",
        reference: "https://docs.zizmor.sh/audits/#template-injection",
      },
    ]);
    expect(find(".github/actions/greet/action.yml", "template-injection").map((f) => [f.lineStart, f.lineEnd])).toEqual([[6, 6]]);
  });

  it("gives a span over several lines its first and last line, and a span ending at column 0 stops on the line before (2, 3)", () => {
    expect(find(".github/workflows/ci.yml", "dangerous-triggers").map((f) => [f.lineStart, f.lineEnd])).toEqual([[1, 2]]);
    // rows 3 to 11 at column 0: the job from line 4 to the file's last line, 11.
    expect(find(".github/workflows/ci.yml", "excessive-permissions").map((f) => [f.lineStart, f.lineEnd])).toEqual([[4, 11]]);
    expect(find(".github/workflows/ci.yml", "artipacked").map((f) => [f.lineStart, f.lineEnd])).toEqual([[7, 9]]);
  });

  it("maps severity, and lowers a low-confidence finding one step (4)", () => {
    const severity = Object.fromEntries(out.map((f) => [`${f.filePath}:${f.ruleId}`, f.severity]));
    expect(severity).toEqual({
      ".github/actions/greet/action.yml:template-injection": "high",
      ".github/dependabot.yml:dependabot-execution": "high",
      ".github/dependabot.yml:dependabot-cooldown": "medium",
      // Medium severity, low confidence.
      ".github/workflows/ci.yml:artipacked": "low",
      ".github/workflows/ci.yml:excessive-permissions": "medium",
      ".github/workflows/ci.yml:dangerous-triggers": "high",
      ".github/workflows/ci.yml:template-injection": "high",
      ".github/workflows/ci.yml:unpinned-uses": "high",
    });
    expect(out).toHaveLength(8);
  });

  it("yields nothing for empty output and skips a finding with no primary local location (5)", () => {
    expect(parseZizmorJson("")).toEqual([]);
    expect(parseZizmorJson("[]")).toEqual([]);
    const one = JSON.parse(fixture)[0];
    const remote = { ...one, locations: one.locations.map((l: { symbolic: object }) => ({ ...l, symbolic: { ...l.symbolic, key: { Remote: { slug: "a/b" } } } })) };
    const noPrimary = { ...one, locations: one.locations.map((l: { symbolic: object }) => ({ ...l, symbolic: { ...l.symbolic, kind: "Related" } })) };
    expect(parseZizmorJson(JSON.stringify([remote, noPrimary, null, 3]))).toEqual([]);
  });
});

describe("the files zizmor is given (6)", () => {
  const facts = repoFacts(dirname(fileURLToPath(import.meta.url)));
  it("takes workflows, action metadata in any folder and the root Dependabot config, as zizmor reads each", () => {
    const changed = [
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      "action.yml",
      ".github/actions/greet/action.yaml",
      "tools/deploy/action.yml",
      ".github/dependabot.yml",
      ".github/dependabot.yaml",
      // Not read by GitHub as what zizmor would take it for.
      "docs/dependabot.yml",
      "config/ci.yml",
      ".github/zizmor.yml",
      ".github/workflows/nested/ci.yml",
      ".github/workflows/README.md",
      "my-action.yml",
    ];
    expect(zizmor.files(changed, facts)).toEqual([
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
      "action.yml",
      ".github/actions/greet/action.yaml",
      "tools/deploy/action.yml",
      ".github/dependabot.yml",
      ".github/dependabot.yaml",
    ]);
  });
});
