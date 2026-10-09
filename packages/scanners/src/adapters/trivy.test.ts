// The trivy config report parser, on a report the 0.75.0 binary wrote for
// test/fixtures/trivy/repo (saved as report.json, its local path replaced).
// Where a whole-block cause is anchored is iac.test.ts's.
//
// Failure list, written before the code:
//   1. A failed check is dropped, or lands on another file or line than
//      trivy's cause; a passed check is kept; trivy's severity is not kept.
//   2. The message loses the check's title or its specific message; the
//      check's page is lost.
//   3. A failed check with no line is dropped instead of being put on the
//      file's first line.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTrivyJson } from "./trivy.js";

const report = readFileSync(new URL("../../test/fixtures/trivy/report.json", import.meta.url), "utf8");

describe("parseTrivyJson", () => {
  it("keeps every failed check of every file on its cause's lines, with trivy's severity (1)", () => {
    const findings = parseTrivyJson(report);
    expect(findings).toHaveLength(27);
    const rows = findings.map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity]);
    expect(rows).toContainEqual(["AWS-0107", "infra/main.tf", 10, 10, "high"]);
    expect(rows).toContainEqual(["AWS-0089", "infra/main.tf", 14, 16, "low"]);
    expect(rows).toContainEqual(["AWS-0090", "infra/main.tf", 14, 16, "medium"]);
    expect(rows).toContainEqual(["AWS-0107", "cfn/stack.yaml", 11, 11, "high"]);
    expect(rows).toContainEqual(["KSV-0017", "k8s/pod.yaml", 7, 10, "high"]);
    expect(rows).toContainEqual(["KSV-0110", "k8s/pod.yaml", 3, 4, "low"]);
  });

  it("writes the title and the message, and links the check's page (2)", () => {
    const sg = parseTrivyJson(report).find((f) => f.ruleId === "AWS-0107" && f.filePath === "infra/main.tf");
    expect(sg).toMatchObject({
      source: "trivy",
      message: "Security groups should not allow unrestricted ingress to SSH or RDP from any IP address: Security group rule allows unrestricted ingress from any IP address.",
      reference: "https://avd.aquasec.com/misconfig/aws-0107",
    });
  });

  it("puts a failed check with no line on line 1, and drops a check that passed (3)", () => {
    const json = JSON.stringify({
      Results: [
        {
          Target: "./stack.json",
          Class: "config",
          Misconfigurations: [
            { ID: "AWS-0001", Title: "A", Message: "a", Severity: "CRITICAL", Status: "FAIL", CauseMetadata: {} },
            { ID: "AWS-0002", Title: "B", Message: "b", Severity: "HIGH", Status: "PASS", CauseMetadata: { StartLine: 3, EndLine: 3 } },
          ],
        },
      ],
    });
    expect(parseTrivyJson(json).map((f) => [f.ruleId, f.filePath, f.lineStart, f.lineEnd, f.severity])).toEqual([["AWS-0001", "stack.json", 1, 1, "critical"]]);
  });
});
