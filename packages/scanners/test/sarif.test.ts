// Ways parseSarif could fail, written before the code:
// 1. Text that is not JSON, or JSON that is not a SARIF log, comes back as an
//    empty list instead of an error, so a broken tool looks clean.
// 2. A path given relative to the scan root (semgrep: uriBaseId %SRCROOT% with
//    no originalUriBaseIds entry; checkov: no base at all) is not resolved
//    against the repo.
// 3. A path given through originalUriBaseIds as an absolute file:// URL
//    (trivy) is not joined with its base, or keeps the file:// prefix.
// 4. A percent-encoded path ("infra%20dir/main.tf") is not decoded.
// 5. The repo folder is reached through a symlink (macOS temp folders live
//    under /var, which is /private/var) and every path looks outside the repo.
// 6. A result outside the repo, with no physical location, with no start line
//    or a start line under 1, or with a non-file URI is kept.
// 7. endLine missing or smaller than startLine gives a bad range.
// 8. Severity ignores security-severity (on the result or on its rule), reads
//    the bands wrong, ignores the result level, ignores the rule's default
//    level, or has no fallback.
// 9. The rule id is missing when the result names its rule only through
//    `rule.id` or `ruleIndex`.
// 10. The message is empty when the result has no message text, and the
//     reference ignores the rule's helpUri.
import { cpSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSarif } from "../src/formats/sarif.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string): string => readFileSync(join(fixtures, "sarif", name), "utf8");

// A temp copy of the sample repo, named by its symlinked path (case 5).
function sampleRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "oq-sarif-"));
  cpSync(join(fixtures, "sample"), dir, { recursive: true });
  return dir;
}

const brief = (findings: ReturnType<typeof parseSarif>) =>
  findings.map((f) => `${f.filePath}:${f.lineStart}-${f.lineEnd} ${f.ruleId} ${f.severity}`);

describe("parseSarif", () => {
  it("throws on text that is not JSON or not SARIF (1)", () => {
    const opts = { repoDir: "/r", source: "custom:x" as const };
    expect(() => parseSarif("not json", opts)).toThrow(/not valid JSON/);
    expect(() => parseSarif("{}", opts)).toThrow(/not a SARIF log/);
    expect(() => parseSarif('{"runs": {}}', opts)).toThrow(/not a SARIF log/);
  });

  it("reads real semgrep SARIF: relative paths, rule default levels, rule security-severity (2, 8)", () => {
    const repoDir = sampleRepo();
    const findings = parseSarif(read("semgrep.sarif"), { repoDir, source: "custom:semgrep" });
    expect(brief(findings)).toEqual([
      "Dockerfile:4-4 tmp.s6-rules.last-user-root medium",
      "app/views.py:6-6 tmp.s6-rules.shell-true high",
      "app/views.py:11-11 tmp.s6-rules.sql-format medium",
      "app/views.py:16-16 tmp.s6-rules.eval-call critical",
    ]);
    expect(findings[1]).toMatchObject({
      source: "custom:semgrep",
      message: "subprocess called with shell=True runs the argument through a shell",
      reference: null,
    });
  });

  it("reads real trivy SARIF: file:// base, percent-encoding, symlinked repo folder (3, 4, 5)", () => {
    const repoDir = sampleRepo();
    // The fixture names /tmp/s6-sample as its root; point it at the real path of
    // the temp copy while the parser is given the symlinked path.
    const realBase = pathToFileURL(realpathSync(repoDir)).href + "/";
    expect(realpathSync(repoDir)).not.toBe(repoDir);
    const json = read("trivy.sarif").replaceAll("file:///tmp/s6-sample/", realBase);
    const findings = parseSarif(json, { repoDir, source: "custom:trivy" });
    expect(findings).toHaveLength(16);
    const files = new Set(findings.map((f) => f.filePath));
    expect([...files].sort()).toEqual(["Dockerfile", "infra dir/main.tf"]);
    const ds2 = findings.find((f) => f.ruleId === "DS-0002");
    expect(ds2).toMatchObject({
      filePath: "Dockerfile",
      lineStart: 4,
      lineEnd: 4,
      severity: "high", // security-severity 8.0
      reference: "https://avd.aquasec.com/misconfig/ds-0002",
    });
    expect(findings.find((f) => f.ruleId === "DS-0001")?.severity).toBe("medium"); // 5.5
    expect(findings.find((f) => f.ruleId === "DS-0026")?.severity).toBe("low"); // 2.0
    expect(findings.find((f) => f.ruleId === "AWS-0099")).toMatchObject({ lineStart: 6, lineEnd: 14 });
    for (const f of findings) expect(f.message.length).toBeGreaterThan(0);
  });

  it("drops every trivy result when the base points outside the repo (6)", () => {
    const repoDir = sampleRepo();
    const findings = parseSarif(read("trivy.sarif"), { repoDir, source: "custom:trivy" });
    expect(findings).toEqual([]);
  });

  it("reads real checkov SARIF: no base id, encoded space, level error (2, 4, 8, 10)", () => {
    const repoDir = sampleRepo();
    const findings = parseSarif(read("checkov.sarif"), { repoDir, source: "custom:checkov" });
    expect(findings).toHaveLength(15);
    const sg = findings.find((f) => f.ruleId === "CKV_AWS_24");
    expect(sg).toMatchObject({
      filePath: "infra dir/main.tf",
      lineStart: 6,
      lineEnd: 14,
      severity: "high",
      message: "Ensure no security groups allow ingress from 0.0.0.0:0 to port 22",
    });
    expect(sg?.reference).toMatch(/^https:\/\/docs\.prismacloud\.io\//);
    expect(findings.filter((f) => f.filePath === "Dockerfile")).toHaveLength(4);
  });

  it("drops results without a usable location and fixes bad ranges (6, 7)", () => {
    const repoDir = sampleRepo();
    const loc = (uri: string, region: object) => [{ physicalLocation: { artifactLocation: { uri }, region } }];
    const log = {
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "t", rules: [] } },
          results: [
            { ruleId: "a", message: { text: "no location" } },
            { ruleId: "b", message: { text: "logical only" }, locations: [{ logicalLocations: [{ name: "x" }] }] },
            { ruleId: "c", message: { text: "line zero" }, locations: loc("Dockerfile", { startLine: 0 }) },
            { ruleId: "d", message: { text: "no region" }, locations: loc("Dockerfile", {}) },
            { ruleId: "e", message: { text: "outside" }, locations: loc("../elsewhere.txt", { startLine: 1 }) },
            { ruleId: "f", message: { text: "absolute outside" }, locations: loc("file:///etc/hosts", { startLine: 1 }) },
            { ruleId: "g", message: { text: "web" }, locations: loc("https://example.com/a.py", { startLine: 1 }) },
            { ruleId: "h", message: { text: "end before start" }, locations: loc("app/views.py", { startLine: 9, endLine: 3 }) },
            { ruleId: "i", message: { text: "absolute inside" }, locations: loc(pathToFileURL(join(repoDir, "Dockerfile")).href, { startLine: 2 }) },
          ],
        },
      ],
    };
    const findings = parseSarif(JSON.stringify(log), { repoDir, source: "custom:t" });
    expect(brief(findings)).toEqual(["app/views.py:9-9 h medium", "Dockerfile:2-2 i medium"]);
  });

  it("reads severity in the documented order and finds rules by index or rule.id (8, 9, 10)", () => {
    const repoDir = sampleRepo();
    const at = (line: number) => [{ physicalLocation: { artifactLocation: { uri: "Dockerfile" }, region: { startLine: line } } }];
    const log = {
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "t",
              rules: [
                { id: "r0", shortDescription: { text: "rule zero" }, helpUri: "https://example.com/r0", defaultConfiguration: { level: "note" } },
                { id: "r1", properties: { "security-severity": "9.0" } },
              ],
            },
          },
          results: [
            { ruleIndex: 0, message: {}, locations: at(1) },
            { rule: { id: "r1" }, message: { text: "m" }, locations: at(2) },
            { ruleId: "r1", level: "note", properties: { "security-severity": "4.0" }, message: { text: "m" }, locations: at(3) },
            { ruleId: "x", properties: { "security-severity": 0 }, message: { text: "m" }, locations: at(4) },
            { ruleId: "x", properties: { "security-severity": "0.1" }, message: { text: "m" }, locations: at(5) },
            { ruleId: "x", level: "error", properties: { "security-severity": "7.0" }, message: { text: "m" }, locations: at(6) },
            { ruleId: "x", level: "warning", message: { text: "m" }, locations: at(7) },
            { ruleId: "x", level: "none", message: { text: "m" }, locations: at(8) },
            { ruleId: "x", level: "error", message: { text: "m" }, locations: at(9) },
            { ruleId: "x", message: { text: "m" }, locations: at(10) },
          ],
        },
      ],
    };
    const findings = parseSarif(JSON.stringify(log), { repoDir, source: "custom:t" });
    expect(findings.map((f) => `${f.lineStart} ${f.ruleId} ${f.severity}`)).toEqual([
      "1 r0 low",
      "2 r1 critical",
      "3 r1 medium",
      "4 x info",
      "5 x low",
      "6 x high",
      "7 x medium",
      "8 x info",
      "9 x high",
      "10 x medium",
    ]);
    expect(findings[0]).toMatchObject({ message: "rule zero", reference: "https://example.com/r0" });
  });
});
